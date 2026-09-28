import { beforeAll, describe, expect, it } from "vitest";
import { getSeedCoachId } from "../../support/fixtures";
import { listBookableSessions } from "../../support/booking-helpers";
import { idempotencyKey, nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

/**
 * New in v1.1.0->develop: a coach can no longer cancel a booking directly (booking-oversight.cancel
 * is now owner-only) — they can only *request* a cancellation (requestCancellation), which an
 * owner then approves or rejects. cancellation-edge-cases.test.ts only covers the client's own
 * direct cancel (bookings.cancel), a separate, still-unchanged endpoint — this file is the new
 * approval-workflow surface.
 */
describe("booking-oversight — coach cancellation-request workflow", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let client: SignedInSession;
  let seedCoachId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    client = await signInAs("client");
    seedCoachId = await getSeedCoachId();
  }, 30_000);

  /** Books a fresh session taught by the seed coach (so `coach` is genuinely the session's own
   * coach — requestCancellation's restrictToCoachId requires that), and returns its bookingId.
   * Grants a fresh PT credit first rather than relying on the seed client's own shared PT
   * balance, which other suites/runs may have already spent. */
  async function bookSessionForSeedCoach(): Promise<{ bookingId: string; sessionId: string }> {
    const sessions = await listBookableSessions(client.client);
    const own = sessions.find((s) => s.coachId === seedCoachId && s.bookedCount < s.capacity);
    if (!own) {
      throw new Error(
        "No bookable session found for the seed coach — run scheduling.materialise first.",
      );
    }

    const grant = await owner.client.post("/credits/grant", {
      clientId: (await client.client.get<{ data: { id: string } }>("/clients/me")).body!.data.id,
      creditType: own.creditType,
      amount: 1,
      expiresAt: null,
      centreScope: null,
      reason: "QA cancellation-request fixture",
    });
    expect(grant.status).toBe(200);

    const res = await client.client.post<{ data: { id: string } }>("/bookings", {
      sessionId: own.id,
      idempotencyKey: idempotencyKey("cancel-req"),
    });
    expect(res.status).toBe(200);
    return { bookingId: res.body!.data.id, sessionId: own.id };
  }

  it("coach requests a cancellation, owner approves it, and the booking ends up cancelled", async () => {
    const { bookingId } = await bookSessionForSeedCoach();

    const request = await coach.client.post<{ data: { requestId: string } }>(
      "/booking-oversight/request-cancellation",
      { bookingId, reason: "QA — approve path" },
    );
    expect(request.status).toBe(200);
    const requestId = request.body!.data.requestId;

    const pending = await owner.client.get<{
      data: { requests: Array<{ id: string; bookingId: string | null }> };
    }>("/booking-oversight/list-pending-cancellation-requests");
    expect(pending.status).toBe(200);
    expect(pending.body?.data?.requests.some((r) => r.id === requestId)).toBe(true);

    const approve = await owner.client.post<{
      data: { requestId: string; status: string; refunded: boolean };
    }>("/booking-oversight/approve-cancellation", { requestId });
    expect(approve.status).toBe(200);
    expect(approve.body?.data?.status).toMatch(/^CANCELLED_/);

    // Approving twice must not double-process the same request.
    const approveAgain = await owner.client.post(
      "/booking-oversight/approve-cancellation",
      { requestId },
    );
    expect(approveAgain.status).not.toBe(200);
  });

  it("coach requests a cancellation, owner rejects it, and the booking is untouched", async () => {
    const { bookingId } = await bookSessionForSeedCoach();

    try {
      const request = await coach.client.post<{ data: { requestId: string } }>(
        "/booking-oversight/request-cancellation",
        { bookingId, reason: "QA — reject path" },
      );
      expect(request.status).toBe(200);
      const requestId = request.body!.data.requestId;

      const reject = await owner.client.post<{ data: { requestId: string } }>(
        "/booking-oversight/reject-cancellation",
        { requestId, reviewNote: "QA — not a valid reason" },
      );
      expect(reject.status).toBe(200);
      expect(reject.body?.data?.requestId).toBe(requestId);

      const pending = await owner.client.get<{ data: { requests: Array<{ id: string }> } }>(
        "/booking-oversight/list-pending-cancellation-requests",
      );
      expect(pending.body?.data?.requests.some((r) => r.id === requestId)).toBe(false);
    } finally {
      // Rejected — the booking is still live, clean it up directly.
      await client.client.post("/bookings/cancel", { bookingId });
    }
  });

  it("a client cannot request a cancellation (coach-only) or approve/reject/list (owner-only)", async () => {
    const { bookingId } = await bookSessionForSeedCoach();
    try {
      const requestAsClient = await client.client.post(
        "/booking-oversight/request-cancellation",
        { bookingId, reason: "should be forbidden" },
      );
      expect(requestAsClient.status).toBe(403);

      const approveAsClient = await client.client.post("/booking-oversight/approve-cancellation", {
        requestId: nonExistentUuid(),
      });
      expect(approveAsClient.status).toBe(403);

      const rejectAsClient = await client.client.post("/booking-oversight/reject-cancellation", {
        requestId: nonExistentUuid(),
        reviewNote: null,
      });
      expect(rejectAsClient.status).toBe(403);

      const listAsClient = await client.client.get(
        "/booking-oversight/list-pending-cancellation-requests",
      );
      expect(listAsClient.status).toBe(403);
    } finally {
      await client.client.post("/bookings/cancel", { bookingId });
    }
  });

  it("approving/rejecting a non-existent request returns 404", async () => {
    const approve = await owner.client.post("/booking-oversight/approve-cancellation", {
      requestId: nonExistentUuid(),
    });
    expect(approve.status).toBe(404);

    const reject = await owner.client.post("/booking-oversight/reject-cancellation", {
      requestId: nonExistentUuid(),
      reviewNote: null,
    });
    expect(reject.status).toBe(404);
  });
});
