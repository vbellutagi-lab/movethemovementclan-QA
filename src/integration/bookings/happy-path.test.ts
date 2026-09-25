import { beforeAll, describe, expect, it } from "vitest";
import { pickDistinctSessions } from "../../support/booking-helpers";
import { idempotencyKey, nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

describe("bookings — happy path & idempotent retry (docs/scenarios.md §7.6)", () => {
  let client: SignedInSession;

  beforeAll(async () => {
    client = await signInAs("client");
  }, 30_000);

  it("books a session, retries idempotently, cancels in time, and is refunded", async () => {
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    const key = idempotencyKey("hp1");
    let bookingId: string | undefined;

    try {
      const res = await client.client.post<{
        data: { id: string; clientId: string; sessionId: string; status: string };
      }>("/bookings", { sessionId, idempotencyKey: key });

      // Note: trpc-to-openapi maps this mutation to HTTP 200, not 201, despite the handler
      // calling TRPCResponse.created() (message: "Booking created") — a harmless status/message
      // mismatch worth flagging, not a functional bug.
      expect(res.status).toBe(200);
      expect(res.body?.data?.sessionId).toBe(sessionId);
      expect(res.body?.data?.status).toBe("CONFIRMED");
      bookingId = res.body!.data.id;

      // Retry with the SAME idempotency key must return the identical booking, not a second one
      // or an error (ADR 0025: three-layer idempotent retry safety).
      const retry = await client.client.post<{ data: { id: string } }>("/bookings", {
        sessionId,
        idempotencyKey: key,
      });
      expect(retry.status).toBe(200);
      expect(retry.body?.data?.id).toBe(bookingId);

      // Cancelling >=4h out refunds the credit (ADR 0027).
      const before = await client.client.get<{ data: { balances: { balance: number }[] } }>(
        "/credits/my-balances",
      );
      const cancel = await client.client.post<{ data: { status: string; refunded: boolean } }>(
        "/bookings/cancel",
        { bookingId },
      );
      expect(cancel.status).toBe(200);
      expect(cancel.body?.data?.status).toBe("CANCELLED_IN_TIME");
      expect(cancel.body?.data?.refunded).toBe(true);
      bookingId = undefined; // already cancelled — don't double-cancel in `finally`

      const after = await client.client.get<{ data: { balances: { balance: number }[] } }>(
        "/credits/my-balances",
      );
      const beforeTotal = before.body!.data.balances.reduce((s, b) => s + b.balance, 0);
      const afterTotal = after.body!.data.balances.reduce((s, b) => s + b.balance, 0);
      expect(afterTotal).toBe(beforeTotal + 1);
    } finally {
      // Guarantee a clean slate even if an assertion above throws mid-test, so a failed run
      // doesn't cascade into unrelated "OverlappingBookingError"s on the next run.
      if (bookingId) await client.client.post("/bookings/cancel", { bookingId });
    }
  });

  it("REGRESSION (fixed): idempotency-key reuse with a DIFFERENT sessionId is now rejected, not silently answered with the original booking (docs/scenarios.md §3.6)", async () => {
    // History: this suite originally recorded a FINDING here. security.html §7 requires
    // idempotency keys to be "bound to ... request parameters" and to "reject reuse of a key
    // with materially different parameters", but the server used to treat the key alone as the
    // dedupe identity — so reusing a key with a different `sessionId` returned 200 plus the
    // FIRST booking's data, telling the caller it had booked a session it never booked.
    //
    // The app has since fixed this (`IdempotencyKeyConflictError`, packages/services/bookings/
    // error.ts), and the check is applied at all three idempotency layers of ADR 0025. This test
    // is now the regression guard for the fix: it asserts the compliant behavior, so a
    // reintroduction of the old silent-success path fails here.
    const key = idempotencyKey("hp-diff-params");
    const [firstSession, secondSession] = await pickDistinctSessions(client.client, 2);
    let bookingId: string | undefined;

    try {
      const first = await client.client.post<{ data: { id: string; sessionId: string } }>(
        "/bookings",
        { sessionId: firstSession.id, idempotencyKey: key },
      );
      expect(first.status).toBe(200);
      bookingId = first.body!.data.id;

      const second = await client.client.post<{ data?: { id: string; sessionId: string } }>(
        "/bookings",
        { sessionId: secondSession.id, idempotencyKey: key },
      );
      expect(second.status).toBe(409);
      // Crucially, no booking payload comes back at all — the old bug's tell was a 200 whose
      // `sessionId` silently disagreed with what the caller had just asked for.
      expect(second.body?.data).toBeUndefined();

      // The original booking must survive the rejected call untouched.
      const reread = await client.client.post<{ data: { id: string; sessionId: string } }>(
        "/bookings",
        { sessionId: firstSession.id, idempotencyKey: key },
      );
      expect(reread.status).toBe(200);
      expect(reread.body?.data?.id).toBe(bookingId);
      expect(reread.body?.data?.sessionId).toBe(firstSession.id);
    } finally {
      if (bookingId) await client.client.post("/bookings/cancel", { bookingId });
    }
  });

  it("cancelling a booking that doesn't exist returns 404", async () => {
    const res = await client.client.post("/bookings/cancel", { bookingId: nonExistentUuid() });
    expect(res.status).toBe(404);
  });
});
