import { beforeAll, describe, expect, it } from "vitest";
import { pickDistinctSessions } from "../../support/booking-helpers";
import { idempotencyKey } from "../../support/random";
import { getSeedCentre, createVerifiedEnrolledClient } from "../../support/fixtures";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * ADRs 0018/0020/0021/0025: row locks in a fixed order (client → session → credit lot), a
 * TOCTOU-closing guarded UPDATE on credit-lot decrement, and a three-layer idempotency design.
 * These are exactly the kind of "hacker/race" scenarios that unit tests against a mocked db
 * (packages/services' own 99 tests) structurally cannot catch — only real concurrent requests
 * against a real Postgres instance can. Each test cancels its own booking(s) before returning
 * (not deferred to afterAll) so a session a test used is free again for the next test.
 */
describe("bookings — concurrency & race conditions (docs/scenarios.md §4)", () => {
  let client: SignedInSession;

  beforeAll(async () => {
    client = await signInAs("client");
  }, 30_000);

  it("firing the identical request (same idempotency key) twice concurrently converges on exactly one booking", async () => {
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    const key = idempotencyKey("race-same-key");

    const [a, b] = await Promise.all([
      client.client.post<{ data: { id: string } }>("/bookings", {
        sessionId,
        idempotencyKey: key,
      }),
      client.client.post<{ data: { id: string } }>("/bookings", {
        sessionId,
        idempotencyKey: key,
      }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body?.data?.id).toBe(b.body?.data?.id); // same key -> same booking, not two rows

    if (a.body?.data?.id) await client.client.post("/bookings/cancel", { bookingId: a.body.data.id });
  });

  it("firing two DIFFERENT booking requests for the same client/session concurrently — exactly one wins", async () => {
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);

    const [a, b] = await Promise.all([
      client.client.post<{ data: { id: string } }>("/bookings", {
        sessionId,
        idempotencyKey: idempotencyKey("race-a"),
      }),
      client.client.post<{ data: { id: string } }>("/bookings", {
        sessionId,
        idempotencyKey: idempotencyKey("race-b"),
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    // One succeeds (200), the other loses to the client-row lock + overlap check (409) — never
    // both succeeding (double-booked) and never both failing (session left unbooked).
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    if (winner.body?.data?.id) {
      await client.client.post("/bookings/cancel", { bookingId: winner.body.data.id });
    }
  });

  it("two different clients race for the last seat on a capacity:1 session — exactly one gets SessionFullError", async () => {
    const centre = await getSeedCentre();
    const owner = await signInAs("owner");

    // Give the seed client's home-centre a fresh session with capacity forced to 1.
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    const capacityRes = await owner.client.post<{ data: { capacity: number } }>(
      "/schedule-exceptions/update",
      { sessionId, capacity: 1, reason: "QA concurrency race fixture — capacity:1" },
    );
    expect(capacityRes.status).toBe(200);
    expect(capacityRes.body?.data?.capacity).toBe(1);

    try {
      // Second client: self-enroll staff@move.dev as a client too (allowed once per user — ADR
      // 0032 — and independent of their org-role `member` row, see the naming-collision note in
      // documents/internals/database.html §5), then grant them a spendable credit.
      const staffAsClient = await signInAs("staff");
      const joinRes = await staffAsClient.client.post("/clients/join", {
        homeCentreId: centre.id,
      });
      expect([200, 201, 409]).toContain(joinRes.status); // 409 = already enrolled from a prior run

      await owner.client.post("/credits/grant", {
        clientId: (await getClientProfile(staffAsClient.client)).id,
        creditType: "SGPT",
        amount: 1,
        expiresAt: null,
        centreScope: null,
        reason: "QA concurrency race fixture — credit for the second racer",
      });

      const [clientResult, staffResult] = await Promise.all([
        client.client.post<{ data: { id: string } }>("/bookings", {
          sessionId,
          idempotencyKey: idempotencyKey("race-c-client"),
        }),
        staffAsClient.client.post<{ data: { id: string } }>("/bookings", {
          sessionId,
          idempotencyKey: idempotencyKey("race-c-staff"),
        }),
      ]);

      const statuses = [clientResult.status, staffResult.status].sort();
      expect(statuses).toEqual([200, 409]);

      const winnerClient = clientResult.status === 200 ? client.client : staffAsClient.client;
      const winner = clientResult.status === 200 ? clientResult : staffResult;
      if (winner.body?.data?.id) {
        await winnerClient.post("/bookings/cancel", { bookingId: winner.body.data.id });
      }
    } finally {
      // Restore capacity so this session doesn't stay artificially constrained for other suites.
      await owner.client.post("/schedule-exceptions/update", {
        sessionId,
        capacity: 20,
        reason: "QA concurrency race fixture — restore capacity",
      });
    }
  });

  it("a client with exactly 1 remaining credit fires two different booking requests concurrently — exactly one succeeds (docs/scenarios.md §4.4)", async () => {
    // Fresh, isolated client (not the shared client@move.dev) so draining to exactly 1 credit
    // can't affect any other test file's assumptions about the seed client's balance.
    const fresh = await createVerifiedEnrolledClient("race-last-credit");
    const owner = await signInAs("owner");
    const freshClientId = (await getClientProfile(fresh.client)).id;

    const grant = await owner.client.post<{ data: { lotId: string; remaining: number } }>(
      "/credits/grant",
      {
        clientId: freshClientId,
        creditType: "SGPT",
        amount: 1,
        expiresAt: null,
        centreScope: null,
        reason: "QA §4.4 last-credit race fixture",
      },
    );
    expect(grant.status).toBe(200);
    expect(grant.body?.data?.remaining).toBe(1);

    // Two DIFFERENT sessions (not the same-session race already covered by 4.2), each with
    // plenty of spare capacity — the only thing that should be able to stop the loser here is
    // the credit-lot guarded decrement (ADR 0020), not a session-capacity check.
    const [sessionA, sessionB] = await pickDistinctSessions(fresh.client, 2);

    const [a, b] = await Promise.all([
      fresh.client.post<{ data: { id: string } }>("/bookings", {
        sessionId: sessionA.id,
        idempotencyKey: idempotencyKey("race-last-credit-a"),
      }),
      fresh.client.post<{ data: { id: string } }>("/bookings", {
        sessionId: sessionB.id,
        idempotencyKey: idempotencyKey("race-last-credit-b"),
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    // One booking succeeds (200); the other must be rejected for insufficient credits (400 —
    // see the §8 422-vs-400 finding), not a phantom double-spend (both 200) and not both
    // failing (the client left with an unspent credit and no booking).
    expect(statuses).toEqual([200, 400]);

    const winner = a.status === 200 ? a : b;
    if (winner.body?.data?.id) {
      await fresh.client.post("/bookings/cancel", { bookingId: winner.body.data.id });
    }
  });
});
