import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TIMED_OUT, type ApiClient } from "../../support/api-client";
import {
  listBookableSessions,
  pickEmptyGroupSessions,
  readSession,
  type SessionListItem,
} from "../../support/booking-helpers";
import {
  ensurePoolCredits,
  getBookingClientPool,
  type PooledClient,
} from "../../support/client-pool";
import { idempotencyKey } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

/**
 * Capacity & duplicate-booking invariants (docs/scenarios.md §4).
 *
 * The three rules under test, stated as invariants rather than as happy paths:
 *
 *   1. **No duplicates.** One client can never hold two live bookings for one session —
 *      however many requests it fires, and whatever idempotency keys it uses.
 *   2. **Capacity is a ceiling, not a target.** `bookedCount` must never exceed `capacity`,
 *      under sequential *or* concurrent load.
 *   3. **Concurrency must not cost seats.** With N racers for K seats, exactly
 *      min(N, K) must win — not fewer. A lock that serialises correctly but rejects
 *      everyone, or leaves seats unsold, is just as wrong as one that oversells.
 *
 * Invariant 3 is why these tests assert an *exact* winner count rather than
 * `winners <= capacity`: "never oversells" is trivially satisfiable by rejecting everything,
 * so an upper-bound-only assertion would pass against a badly broken implementation.
 *
 * ## Test order matters in this file
 *
 * The high-concurrency races are declared **last**, deliberately. They currently trip a
 * connection-pool deadlock that leaves the entire API unable to serve any database-backed
 * route until it is restarted (docs/scenarios.md §4.12). Ordering them after the low-concurrency
 * tests means a wedge doesn't invalidate everything else in the file — you still get the
 * duplicate/ceiling/ramp results before the API goes down.
 *
 * Every test restores what it touched (bookings cancelled, capacity overrides reverted) so the
 * file is re-runnable and doesn't strand seats for the rest of the suite.
 */

const POOL_SIZE = 10;
const CREDIT_TYPE = "SGPT";
/** pickEmptyGroupSessions treats everything except this as a bookable group session. */
const CREDIT_TYPE_EXCLUDED = "PT";

/**
 * Per-request ceiling for a booking in a race. Generous next to a healthy booking (tens of
 * milliseconds) but far below vitest's own test timeout, so a wedged server is reported as
 * "these specific requests never came back" rather than killing the file with no detail.
 */
const BOOKING_TIMEOUT_MS = 15_000;

/** One booking attempt's outcome plus the wall-clock window it occupied. */
interface AttemptTiming {
  label: string;
  status: number;
  bookingId?: string;
  /** ms from when the whole batch was fired to when this request was issued. */
  startOffsetMs: number;
  /** ms from when the whole batch was fired to when this response landed. */
  endOffsetMs: number;
  durationMs: number;
  timedOut: boolean;
}

interface RaceResult {
  attempts: AttemptTiming[];
  /** Wall-clock from firing the first request to the last response landing. */
  totalMs: number;
  winners: AttemptTiming[];
  losers: AttemptTiming[];
  timedOutAttempts: AttemptTiming[];
}

/** Fires one booking per client simultaneously and records exactly when each one ran. */
async function raceForSeats(
  racers: Array<{ label: string; client: ApiClient }>,
  sessionId: string,
  keyPrefix: string,
): Promise<RaceResult> {
  return raceForSessions(
    racers.map((r) => ({ ...r, sessionId })),
    keyPrefix,
  );
}

/**
 * Like {@link raceForSeats}, but each racer books its OWN session instead of all racers
 * contending for one — used to isolate pure pool-connection pressure (every racer needs a
 * `tx` connection) from row-lock contention (every racer wants the same `sessions` row). See
 * the 4.12 open question this file's last test closes: does the connection count alone deadlock
 * the pool, independent of any lock contention?
 */
async function raceForSessions(
  racers: Array<{ label: string; client: ApiClient; sessionId: string }>,
  keyPrefix: string,
): Promise<RaceResult> {
  const t0 = performance.now();

  const attempts = await Promise.all(
    racers.map(async ({ label, client, sessionId }): Promise<AttemptTiming> => {
      const startOffsetMs = performance.now() - t0;
      const res = await client.post<{ data?: { id: string } }>(
        "/bookings",
        { sessionId, idempotencyKey: idempotencyKey(`${keyPrefix}-${label}`) },
        { timeoutMs: BOOKING_TIMEOUT_MS },
      );
      const endOffsetMs = performance.now() - t0;
      return {
        label,
        status: res.status,
        bookingId: res.body?.data?.id,
        startOffsetMs,
        endOffsetMs,
        durationMs: endOffsetMs - startOffsetMs,
        timedOut: res.status === TIMED_OUT,
      };
    }),
  );

  const totalMs = performance.now() - t0;
  return {
    attempts,
    totalMs,
    winners: attempts.filter((a) => a.status === 200),
    losers: attempts.filter((a) => a.status !== 200 && a.status !== TIMED_OUT),
    timedOutAttempts: attempts.filter((a) => a.status === TIMED_OUT),
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

/**
 * Fails with a diagnosis rather than a bare assertion mismatch when requests never returned.
 * A timeout here is not a flaky-test problem: it means the server stopped answering, and the
 * useful signal is *how many* stalled and that the API is now down for everything else.
 */
function assertNoStalls(race: RaceResult, context: string): void {
  if (race.timedOutAttempts.length === 0) return;
  throw new Error(
    `${context}: ${race.timedOutAttempts.length}/${race.attempts.length} booking requests ` +
      `never returned within ${BOOKING_TIMEOUT_MS}ms ` +
      `(${race.timedOutAttempts.map((a) => a.label).join(", ")}).\n` +
      `The API is almost certainly wedged: every database-backed route will now hang until it ` +
      `is restarted. This is the connection-pool-exhaustion deadlock documented in ` +
      `docs/scenarios.md §4.12 — CreditBasedChargeStrategy.chargeFor calls pickCreditLot on the ` +
      `pooled 'db' handle instead of the open transaction 'tx', so a booking that already holds ` +
      `the session row lock has to borrow a second connection to finish. Once concurrent ` +
      `bookings equal the pg pool size (default max: 10), there is no second connection to ` +
      `borrow and no request can make progress.`,
  );
}

/**
 * Prints the timing table. The per-request numbers matter as much as the total: if the
 * `issued over` window is wide, the requests weren't actually concurrent and a "capacity held
 * under concurrency" pass would be meaningless — it would just be a sequential test in disguise.
 */
function reportRace(title: string, race: RaceResult, capacity: number): void {
  const durations = race.attempts.map((a) => a.durationMs).sort((a, b) => a - b);
  const slowest = durations[durations.length - 1] ?? 0;
  const fastest = durations[0] ?? 0;
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  const issueSpread = Math.max(...race.attempts.map((a) => a.startOffsetMs));

  const lines = [
    "",
    `  ── ${title} ──`,
    `  racers: ${race.attempts.length}   capacity: ${capacity}   ` +
      `won: ${race.winners.length}   rejected: ${race.losers.length}   ` +
      `never answered: ${race.timedOutAttempts.length}`,
    `  TOTAL WALL CLOCK (first request out → last response in): ${seconds(race.totalMs)}`,
    `  per-request: fastest ${seconds(fastest)} | median ${seconds(median)} | slowest ${seconds(slowest)}`,
    `  throughput: ${(race.attempts.length / (race.totalMs / 1000)).toFixed(1)} booking attempts/sec`,
    `  all ${race.attempts.length} requests issued over a ${seconds(issueSpread)} window (smaller = more truly concurrent)`,
    "  ---- per racer ----",
    ...[...race.attempts]
      .sort((a, b) => a.endOffsetMs - b.endOffsetMs)
      .map(
        (a) =>
          `   ${a.timedOut ? "HUNG" : a.status === 200 ? "WON " : "RJCT"}  ${a.label.padEnd(16)} ` +
          `${a.timedOut ? "no response" : `HTTP ${a.status}`}  took ${seconds(a.durationMs).padStart(8)}  ` +
          `(settled at +${seconds(a.endOffsetMs)})`,
      ),
    "",
  ];
  console.log(lines.join("\n"));
}

describe("bookings — capacity ceiling & duplicate prevention (docs/scenarios.md §4)", () => {
  let seedClient: SignedInSession;
  let owner: SignedInSession;
  let pool: PooledClient[];

  /** Bookings created by the running test, cancelled in afterEach even if it threw. */
  let createdBookings: Array<{ client: ApiClient; bookingId: string }> = [];
  /** Class templates created by the running test, soft-deleted in afterEach even if it threw. */
  let createdTemplateIds: string[] = [];
  /** Capacity overrides applied by the running test, reverted in afterEach even if it threw. */
  let capacityOverrides: Array<{ sessionId: string; original: number }> = [];

  beforeAll(async () => {
    seedClient = await signInAs("client");
    owner = await signInAs("owner");
    pool = await getBookingClientPool(POOL_SIZE);
    // Every racer must be able to afford the booking, so that capacity is provably the only
    // thing that can reject it (an InsufficientCreditsError is a 400, not the 409 we assert).
    await ensurePoolCredits(pool, CREDIT_TYPE, 1);
  }, 600_000);

  afterEach(async () => {
    // Best-effort: once the API is wedged these cancels hang too, and a failing afterEach
    // would bury the actual diagnosis from the test that wedged it.
    await Promise.allSettled(
      createdBookings.map(({ client, bookingId }) =>
        client.post("/bookings/cancel", { bookingId }, { timeoutMs: BOOKING_TIMEOUT_MS }),
      ),
    );
    createdBookings = [];

    await Promise.allSettled(
      capacityOverrides.map(({ sessionId, original }) =>
        owner.client.post(
          "/schedule-exceptions/update",
          { sessionId, capacity: original, reason: "QA capacity suite — restore original capacity" },
          { timeoutMs: BOOKING_TIMEOUT_MS },
        ),
      ),
    );
    capacityOverrides = [];

    // Deleting a template also cancels the not-yet-started sessions materialised from it.
    await Promise.allSettled(
      createdTemplateIds.map((id) =>
        owner.client.post("/class-templates/delete", { id }, { timeoutMs: BOOKING_TIMEOUT_MS }),
      ),
    );
    createdTemplateIds = [];
  }, 120_000);

  /**
   * Returns `count` distinct empty group sessions, creating throwaway class templates (and
   * materialising them) if the seed data doesn't have enough. A freshly reseeded database only
   * has a handful of future sessions, and the different-sessions race needs one per racer.
   */
  async function ensureEmptyGroupSessions(count: number): Promise<SessionListItem[]> {
    const enough = async () =>
      (await listBookableSessions(seedClient.client)).filter(
        (s) => s.creditType !== CREDIT_TYPE_EXCLUDED && s.bookedCount === 0,
      );
    let available = await enough();
    if (available.length >= count) return pickEmptyGroupSessions(seedClient.client, count);

    const templates = await owner.client.get<{
      data: Array<{ sessionTypeId: string; centreId: string; coachId: string }>;
    }>("/class-templates");
    const ref = templates.body?.data?.[0];
    if (!ref) throw new Error("No class template to borrow ids from — is the instance seeded?");

    const weekdays = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const tomorrow = weekdays[(new Date().getDay() + 1) % 7]!;
    for (let i = 0; available.length + i < count; i++) {
      const res = await owner.client.post<{ data: { id: string } }>("/class-templates", {
        ...ref,
        weekday: tomorrow,
        startTime: `${String(5 + i).padStart(2, "0")}:00`,
        capacity: 3,
        activeFrom: new Date().toISOString().slice(0, 10),
      });
      expect(res.status).toBe(200);
      createdTemplateIds.push(res.body!.data.id);
    }
    expect((await owner.client.post("/scheduling/materialise", {})).status).toBe(200);

    available = await enough();
    if (available.length < count) {
      throw new Error(`Still only ${available.length} empty sessions after creating templates.`);
    }
    return pickEmptyGroupSessions(seedClient.client, count);
  }

  /** Forces a session's capacity, remembering the original so afterEach can put it back. */
  async function setCapacity(session: SessionListItem, capacity: number): Promise<void> {
    const res = await owner.client.post<{ data: { capacity: number } }>(
      "/schedule-exceptions/update",
      { sessionId: session.id, capacity, reason: `QA capacity suite — force capacity ${capacity}` },
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.capacity).toBe(capacity);
    capacityOverrides.push({ sessionId: session.id, original: session.capacity });
  }

  /** Registers a race's winners for cleanup in afterEach. */
  function trackWinners(race: RaceResult, racers: PooledClient[]): void {
    for (const w of race.winners) {
      const member = racers.find((m) => m.label === w.label);
      if (member && w.bookingId) {
        createdBookings.push({ client: member.client, bookingId: w.bookingId });
      }
    }
  }

  // ── Rule 1: a client cannot duplicate a booking for the same session ──────────────────

  it("rejects a second booking of the same session by the same client (fresh idempotency key, so it is a genuine duplicate and not a retry)", async () => {
    const [session] = await pickEmptyGroupSessions(seedClient.client, 1, { minCapacity: 2 });

    const first = await seedClient.client.post<{ data: { id: string } }>("/bookings", {
      sessionId: session.id,
      idempotencyKey: idempotencyKey("dup-first"),
    });
    expect(first.status).toBe(200);
    createdBookings.push({ client: seedClient.client, bookingId: first.body!.data.id });

    // A DIFFERENT idempotency key — so idempotent-retry dedupe (ADR 0025) cannot be what
    // stops this. The only thing left to reject it is genuine duplicate detection, which this
    // service implements as an overlapping-bookings check (a session always overlaps itself).
    const second = await seedClient.client.post<{ data?: { id: string } }>("/bookings", {
      sessionId: session.id,
      idempotencyKey: idempotencyKey("dup-second"),
    });
    expect(second.status).toBe(409);
    // Must not be a silently-returned copy of the first booking either.
    expect(second.body?.data?.id).toBeUndefined();

    // The seat count is the real invariant — one client, one seat, regardless of request count.
    const after = await readSession(seedClient.client, session.id);
    expect(after?.bookedCount).toBe(1);
  });

  it("still holds exactly one seat when the same client fires three duplicates concurrently with distinct keys", async () => {
    const [session] = await pickEmptyGroupSessions(seedClient.client, 1, { minCapacity: 5 });

    const race = await raceForSeats(
      [
        { label: "self-a", client: seedClient.client },
        { label: "self-b", client: seedClient.client },
        { label: "self-c", client: seedClient.client },
      ],
      session.id,
      "dup-race",
    );
    for (const w of race.winners) {
      if (w.bookingId) createdBookings.push({ client: seedClient.client, bookingId: w.bookingId });
    }
    assertNoStalls(race, "same-client concurrent duplicates");

    // Capacity here is 5+, so nothing is competing for seats — the only constraint is that one
    // client may not double-book itself. Exactly one must win, and the losers must be 409s.
    expect(race.winners).toHaveLength(1);
    expect(race.losers.map((l) => l.status)).toEqual([409, 409]);

    const after = await readSession(seedClient.client, session.id);
    expect(after?.bookedCount).toBe(1);
  });

  // ── Rule 2: capacity is a hard ceiling ───────────────────────────────────────────────

  it("rejects the (capacity + 1)-th booking when clients book sequentially", async () => {
    const capacity = 2;
    const [session] = await pickEmptyGroupSessions(seedClient.client, 1, { minCapacity: capacity });
    await setCapacity(session, capacity);

    const statuses: number[] = [];
    for (const member of pool.slice(0, capacity + 1)) {
      const res = await member.client.post<{ data?: { id: string } }>("/bookings", {
        sessionId: session.id,
        idempotencyKey: idempotencyKey(`seq-${member.label}`),
      });
      statuses.push(res.status);
      if (res.body?.data?.id) {
        createdBookings.push({ client: member.client, bookingId: res.body.data.id });
      }
    }

    // The first `capacity` succeed; the one that would push bookedCount past capacity is
    // refused with SessionFullError → 409.
    expect(statuses).toEqual([...Array(capacity).fill(200), 409]);

    const after = await readSession(seedClient.client, session.id);
    expect(after?.bookedCount).toBe(capacity);
    expect(after!.bookedCount).toBeLessThanOrEqual(after!.capacity);
  });

  // ── Rule 3: concurrency must not cost seats, and must not cost liveness ──────────────

  it("stays responsive and correct as parallel demand ramps 2 → 4 → 6 → 8 clients", async () => {
    const levels = [2, 4, 6, 8];
    const summary: string[] = [];

    for (const n of levels) {
      const [session] = await pickEmptyGroupSessions(seedClient.client, 1, { minCapacity: n });
      const racers = pool.slice(0, n);
      const race = await raceForSeats(racers, session.id, `ramp-${n}`);
      trackWinners(race, racers);

      assertNoStalls(
        race,
        `booking ramp at ${n} concurrent clients (it survived ${levels
          .filter((l) => l < n)
          .join(", ")})`,
      );

      // Capacity is not the constraint at any level here (session capacity >= n), so every
      // racer must win. Anything less means seats were lost to lock contention alone.
      expect(race.winners, `all ${n} racers should win when capacity >= ${n}`).toHaveLength(n);

      summary.push(
        `    N=${String(n).padStart(2)}  total ${seconds(race.totalMs).padStart(8)}  ` +
          `slowest request ${seconds(Math.max(...race.attempts.map((a) => a.durationMs))).padStart(8)}  ` +
          `${(n / (race.totalMs / 1000)).toFixed(1)} bookings/sec`,
      );

      // Free the seats before the next level, which reuses the same pool members.
      await Promise.allSettled(
        createdBookings.map(({ client, bookingId }) =>
          client.post("/bookings/cancel", { bookingId }, { timeoutMs: BOOKING_TIMEOUT_MS }),
        ),
      );
      createdBookings = [];
    }

    console.log(["", "  ── concurrency ramp (all racers should win) ──", ...summary, ""].join("\n"));
  }, 180_000);

  it(`oversubscribes a capacity-3 session with ${POOL_SIZE} clients booking in parallel — exactly 3 win, 7 are rejected, none oversell`, async () => {
    const capacity = 3;
    const [session] = await pickEmptyGroupSessions(seedClient.client, 1, { minCapacity: capacity });
    await setCapacity(session, capacity);

    const race = await raceForSeats(pool, session.id, "oversubscribe");
    trackWinners(race, pool);
    reportRace(`${POOL_SIZE} clients → capacity ${capacity} (oversubscribed)`, race, capacity);
    assertNoStalls(race, `${POOL_SIZE}-way oversubscription of a capacity-${capacity} session`);

    // Exactly the capacity wins — no oversell (would be > 3) and no lost seats from lock
    // contention (would be < 3).
    expect(race.winners).toHaveLength(capacity);
    expect(race.losers).toHaveLength(POOL_SIZE - capacity);
    // Every rejection must be SessionFullError (409). A 400 would mean a racer ran out of
    // credits and the seat was never actually contested; a 500 would mean a deadlock escaped.
    expect([...new Set(race.losers.map((l) => l.status))]).toEqual([409]);
    // Distinct winners — no single client got two seats.
    expect(new Set(race.winners.map((w) => w.label)).size).toBe(capacity);
    expect(new Set(race.winners.map((w) => w.bookingId)).size).toBe(capacity);

    const after = await readSession(seedClient.client, session.id);
    expect(after?.bookedCount).toBe(capacity);
  }, 180_000);

  it(`fills a capacity-${POOL_SIZE} session with ${POOL_SIZE} clients booking in parallel — all ${POOL_SIZE} win (no seat lost to lock contention)`, async () => {
    const capacity = POOL_SIZE;
    const [session] = await pickEmptyGroupSessions(seedClient.client, 1, { minCapacity: capacity });
    await setCapacity(session, capacity);

    const race = await raceForSeats(pool, session.id, "fill-exact");
    trackWinners(race, pool);
    reportRace(`${POOL_SIZE} clients → capacity ${capacity} (exact fit)`, race, capacity);
    assertNoStalls(race, `${POOL_SIZE}-way exact fill of a capacity-${capacity} session`);

    // The pure-throughput case: demand exactly equals supply, so a correct implementation
    // rejects nobody. Any 409 here is a seat lost to the row lock, not to real contention.
    expect(race.losers).toEqual([]);
    expect(race.winners).toHaveLength(POOL_SIZE);

    const after = await readSession(seedClient.client, session.id);
    expect(after?.bookedCount).toBe(capacity);
    expect(after!.bookedCount).toBeLessThanOrEqual(after!.capacity);
  }, 180_000);

  // ── The 4.12 open question: is this "any 10 concurrent bookings", not just same-session? ──

  it(
    `closes docs/findings/4.12's open question — ${POOL_SIZE} concurrent bookings of ${POOL_SIZE} ` +
      `DIFFERENT sessions (zero row-lock contention) don't exhaust the connection pool either`,
    async () => {
      // Re-top-up rather than trust beforeAll's one-time grant: the immediately-preceding
      // exact-fit test just spent every pool member's credit, and cancel-refund only fires
      // ≥4h before a session's start (ADR 0027) — for a near-term seed session it doesn't, so a
      // racer here could otherwise lose to "out of credit" (400) rather than the thing this test
      // is actually checking, exactly the failure mode ensurePoolCredits' own docstring warns
      // about.
      await ensurePoolCredits(pool, CREDIT_TYPE, 1);

      // Distinct sessions, one per racer — nobody contends for the same `sessions` row, so if
      // this still stalls, the bug is "any N concurrent bookings" (pure connection pressure from
      // chargeFor's tx + a second pickCreditLot connection), not "N bookings of one session".
      // Before the docs/findings/4.12 fix (pickCreditLot threaded onto the booking's own tx),
      // the mechanism predicts this deadlocks the pool exactly like the same-session races above,
      // even though there is nothing here for a row lock to serialize.
      const sessions = await ensureEmptyGroupSessions(POOL_SIZE);
      const racers = pool.map((member, i) => ({
        label: member.label,
        client: member.client,
        sessionId: sessions[i]!.id,
      }));

      const race = await raceForSessions(racers, "diff-sessions");
      for (const w of race.winners) {
        const member = pool.find((m) => m.label === w.label);
        if (member && w.bookingId) {
          createdBookings.push({ client: member.client, bookingId: w.bookingId });
        }
      }
      reportRace(`${POOL_SIZE} clients → ${POOL_SIZE} distinct sessions (no lock contention)`, race, 1);
      assertNoStalls(race, `${POOL_SIZE}-way concurrent bookings of ${POOL_SIZE} distinct sessions`);

      // No capacity constraint and no shared row to contend over — every racer must win.
      expect(race.winners).toHaveLength(POOL_SIZE);
      expect(race.losers).toEqual([]);

      for (const session of sessions) {
        const after = await readSession(seedClient.client, session.id);
        expect(after?.bookedCount).toBe(1);
      }
    },
    180_000,
  );
});
