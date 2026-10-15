import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LifecycleCleanup,
  balances,
  book,
  createLifecycleClient,
  grantCredits,
  istDate,
  lifecycle,
  lotsFor,
  seedBookableSessions,
  type LifecycleClient,
} from "../../support/lifecycle";
import { nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

interface BookingRow {
  id: string;
  status: string;
  sessionId: string;
}

/**
 * member-lifecycle-e2e.md §3 (pause), §3.3b (scheduled pause), §4 (resume) and the paused-client
 * parts of §9. Each test pauses its own throwaway client, so the shared seed members are never
 * touched. Credit type is taken from the session the client books, never hard-coded.
 */
describe("member lifecycle — client pause / resume (§3, §4, §9)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let creditType: string;
  let sessionIds: string[];

  beforeAll(async () => {
    owner = await signInAs("owner");
    const sessions = await seedBookableSessions(cleanup, 4);
    sessionIds = sessions.map((s) => s.id);
    creditType = sessions[0]!.creditType;
  }, 90_000);

  afterAll(() => cleanup.run());

  /** A fresh client holding 4 credits of the sessions' type, plus `bookings` confirmed bookings. */
  async function seedClient(label: string, bookings: number, opts: { expiresAt?: string | null } = {}) {
    const c = cleanup.trackClient(await createLifecycleClient(label));
    const lotId = await grantCredits(c.clientId, creditType, 4, opts);
    const booked: string[] = [];
    for (let i = 0; i < bookings; i++) {
      const res = await book(c.client, sessionIds[i]!);
      expect(res.status, res.rawText.slice(0, 200)).toBe(200);
      booked.push(res.body.data.id);
    }
    return { c, lotId, booked };
  }

  const upcoming = async (c: LifecycleClient): Promise<BookingRow[]> =>
    (
      await owner.client.get<{ data: { bookings: BookingRow[] } }>(
        `/booking-oversight/list-for-client?clientId=${c.clientId}&filter=upcoming`,
      )
    ).body.data.bookings;

  const pauseBody = (c: LifecycleClient, extra: Record<string, unknown> = {}) => ({
    clientId: c.clientId,
    reason: "QA travelling",
    pausedFrom: istDate(),
    lotIdsToFreeze: [] as string[],
    bookingDecisions: [] as unknown[],
    ...extra,
  });

  // ---------------------------------------------------------------- happy path

  it("CP-01..CP-04/CR-01/CR-02 — pause cancels the booking, returns the credit and holds the lot; resume releases it", async () => {
    const { c, lotId, booked } = await seedClient("lc-pause-happy", 1);
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 3, frozen: 0 });

    const res = await lifecycle.pause(
      owner.client,
      pauseBody(c, {
        pausedUntil: istDate(30),
        lotIdsToFreeze: [lotId],
        bookingDecisions: [{ bookingId: booked[0], action: "CANCEL_AND_FREEZE" }],
      }),
    );
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    expect((res.body as { data: { status: string } }).data.status).toBe("PAUSED");

    // Credit came back (3 -> 4) and is now held, so nothing is spendable.
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 0, frozen: 4 });
    expect(await upcoming(c)).toHaveLength(0);

    const me = await c.client.get<{ data: { status: string; pauseState?: string } }>("/clients/me");
    expect(me.body.data).toMatchObject({ status: "PAUSED", pauseState: "IN_EFFECT" });

    const resume = await lifecycle.resume(owner.client, c.clientId);
    expect(resume.status, resume.rawText.slice(0, 300)).toBe(200);
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 4, frozen: 0 });
    const after = await c.client.get<{ data: { status: string } }>("/clients/me");
    expect(after.body.data.status).toBe("ACTIVE");
  }, 90_000);

  it("CP-20/CP-24 — 'No refund' cancels the booking but does not return the credit", async () => {
    const { c, lotId, booked } = await seedClient("lc-pause-norefund", 1);
    const res = await lifecycle.pause(
      owner.client,
      pauseBody(c, {
        lotIdsToFreeze: [lotId],
        bookingDecisions: [{ bookingId: booked[0], action: "CANCEL_NO_REFUND" }],
      }),
    );
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 0, frozen: 3 });
    expect(await upcoming(c)).toHaveLength(0);
  }, 90_000);

  it("CP-09 — a lot left unticked stays spendable while the ticked one is held", async () => {
    const { c, lotId } = await seedClient("lc-pause-partial", 0);
    const second = await grantCredits(c.clientId, creditType, 2);
    const res = await lifecycle.pause(owner.client, pauseBody(c, { lotIdsToFreeze: [lotId] }));
    expect(res.status).toBe(200);
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 2, frozen: 4 });
    expect((await lotsFor(c.clientId)).find((l) => l.id === second)?.remaining).toBe(2);
  }, 90_000);

  it("CP-08/CP-10 — a client with no credits and no bookings can be paused with no expected-back date", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-pause-bare"));
    const res = await lifecycle.pause(owner.client, pauseBody(c));
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
  }, 60_000);

  it("CR-04/CR-06 — resuming straight away leaves a no-expiry lot null and does not shorten a dated lot", async () => {
    const expiresAt = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const { c, lotId } = await seedClient("lc-resume-expiry", 0, { expiresAt });
    const noExpiry = await grantCredits(c.clientId, creditType, 1);
    await lifecycle.pause(owner.client, pauseBody(c, { lotIdsToFreeze: [lotId, noExpiry] }));
    expect((await lifecycle.resume(owner.client, c.clientId)).status).toBe(200);

    const lots = await lotsFor(c.clientId);
    expect(lots.find((l) => l.id === noExpiry)?.expiresAt).toBeNull();
    const dated = new Date(lots.find((l) => l.id === lotId)!.expiresAt!).getTime();
    expect(dated).toBeGreaterThanOrEqual(new Date(expiresAt).getTime() - 1000);
    // The hold starts at IST midnight of the From date (SP-09), not at the click, so pausing
    // "from today" extends by at most the time elapsed since that midnight. (The plan's CR-06
    // says "≈ 0" - that only holds for a pause that starts later than today.)
    const sinceIstMidnight = Date.now() - new Date(`${istDate()}T00:00:00+05:30`).getTime();
    expect(dated - new Date(expiresAt).getTime()).toBeLessThanOrEqual(sinceIstMidnight + 5 * 60_000);
  }, 90_000);

  // ---------------------------------------------------------------- validation

  it("CP-30/CP-37/CP-38 — blank reason, past start and return-before-start are 400 and change nothing", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-pause-invalid"));
    for (const [what, extra] of [
      ["blank reason", { reason: "   " }],
      ["start in the past", { pausedFrom: istDate(-2) }],
      ["return before start", { pausedFrom: istDate(3), pausedUntil: istDate(1) }],
    ] as const) {
      const res = await lifecycle.pause(owner.client, pauseBody(c, extra));
      expect(res.status, `${what}: ${res.rawText.slice(0, 160)}`).toBe(400);
    }
    const me = await c.client.get<{ data: { status: string } }>("/clients/me");
    expect(me.body.data.status).toBe("ACTIVE");
  }, 60_000);

  it("CP-31/CP-32/CP-21 — foreign lot, foreign booking and an unknown action are 400 with nothing changed", async () => {
    const a = await seedClient("lc-pause-a", 1);
    const b = await seedClient("lc-pause-b", 1);

    const foreignLot = await lifecycle.pause(owner.client, pauseBody(a.c, { lotIdsToFreeze: [b.lotId] }));
    expect(foreignLot.status).toBe(400);

    const foreignBooking = await lifecycle.pause(
      owner.client,
      pauseBody(a.c, {
        lotIdsToFreeze: [a.lotId],
        bookingDecisions: [{ bookingId: b.booked[0], action: "CANCEL_AND_FREEZE" }],
      }),
    );
    expect(foreignBooking.status).toBe(400);

    const keep = await lifecycle.pause(
      owner.client,
      pauseBody(a.c, { bookingDecisions: [{ bookingId: a.booked[0], action: "KEEP" }] }),
    );
    expect(keep.status).toBe(400);

    // Nothing moved for A: still ACTIVE, booking intact, lot unfrozen.
    expect((await upcoming(a.c)).map((x) => x.status)).toEqual(["CONFIRMED"]);
    expect(await balances(a.c.clientId, creditType)).toEqual({ balance: 3, frozen: 0 });
  }, 120_000);

  it("CP-33/CR-09 — pausing a paused client and resuming an active one are 409", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-pause-409"));
    expect((await lifecycle.resume(owner.client, c.clientId)).status).toBe(409);
    expect((await lifecycle.pause(owner.client, pauseBody(c))).status).toBe(200);
    expect((await lifecycle.pause(owner.client, pauseBody(c))).status).toBe(409);
    expect((await lifecycle.resume(owner.client, c.clientId)).status).toBe(200);
  }, 60_000);

  it("CP-34/CR-10 — an ARCHIVED client can be neither paused nor resumed (409)", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-pause-archived"));
    expect(
      (await lifecycle.archiveClient(owner.client, { clientId: c.clientId, reason: "QA", bookingDecisions: [] }))
        .status,
    ).toBe(200);
    expect((await lifecycle.pause(owner.client, pauseBody(c))).status).toBe(409);
    expect((await lifecycle.resume(owner.client, c.clientId)).status).toBe(409);
  }, 60_000);

  it("CP-51/CP-52 — two simultaneous pauses: exactly one wins, the other is 409", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-pause-race"));
    const results = await Promise.all([
      lifecycle.pause(owner.client, pauseBody(c)),
      lifecycle.pause(owner.client, pauseBody(c)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  }, 60_000);

  // ---------------------------------------------------------------- paused client is read-only (§9 B-01, B-13)

  it("B-01/B-13/G-05 — a paused client cannot book, cancel or request a renewal (403), but can still read and edit their profile", async () => {
    const { c, lotId, booked } = await seedClient("lc-paused-ro", 1);
    // Keep a second booking by NOT passing it to the decisions? Decisions are mandatory per
    // booking, so cancel it, then try to act on the cancelled one and on a new session.
    await lifecycle.pause(
      owner.client,
      pauseBody(c, {
        lotIdsToFreeze: [lotId],
        bookingDecisions: [{ bookingId: booked[0], action: "CANCEL_AND_FREEZE" }],
      }),
    );

    const book403 = await book(c.client, sessionIds[3]!);
    expect(book403.status, book403.rawText.slice(0, 200)).toBe(403);
    expect(book403.rawText).toMatch(/paused/i);

    expect((await c.client.post("/bookings/cancel", { bookingId: booked[0] })).status).toBe(403);
    expect(
      (await c.client.post("/billing/request-renewal", { packageId: nonExistentUuid() })).status,
    ).toBe(403);

    // read-only portal still works
    expect((await c.client.get("/credits/my-balances")).status).toBe(200);
    expect((await c.client.get("/clients/me")).status).toBe(200);
    const edit = await c.client.patch("/clients/me", { emergencyContact: "QA contact" });
    expect(edit.status).toBe(200);
  }, 120_000);

  it("B-04 — admin 'create booking' for a paused client is refused", async () => {
    const { c, lotId } = await seedClient("lc-paused-admin-book", 0);
    await lifecycle.pause(owner.client, pauseBody(c, { lotIdsToFreeze: [lotId] }));
    const res = await owner.client.post("/booking-oversight/create-manual", {
      clientId: c.clientId,
      sessionId: sessionIds[2],
      idempotencyKey: `qa-lc-${Date.now()}`,
    });
    expect(res.status, res.rawText.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(await upcoming(c)).toHaveLength(0);
  }, 90_000);

  it("A-09/R-13 — a paused client can still sign in and clients.me carries the new status field additively", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-paused-me"));
    await lifecycle.pause(owner.client, pauseBody(c));
    const me = await c.client.get<{ data: Record<string, unknown> }>("/clients/me");
    expect(me.status).toBe(200);
    // Existing fields are still there; `status` is the addition.
    for (const k of ["id", "userId", "homeCentreId", "assignedCoachId", "joinedAt", "status"]) {
      expect(me.body.data, k).toHaveProperty(k);
    }
  }, 60_000);

  // ---------------------------------------------------------------- scheduled pause (§3.3b)

  it("SP-01/SP-05/SP-06/SP-08 — a future-dated pause leaves the client able to book before it starts, blocks on/after it, and can be cancelled", async () => {
    const { c, lotId } = await seedClient("lc-sched", 0);
    const sessions = await seedBookableSessions(cleanup, 4);
    const startOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
    const earliest = sessions[0]!;
    // Pause starts the day after the earliest session so that one stays bookable.
    const from = new Date(new Date(earliest.startsAt).getTime() + 86_400_000).toISOString();
    const later = sessions.find((s) => startOf(s.startsAt) >= startOf(from));

    const res = await lifecycle.pause(
      owner.client,
      pauseBody(c, { pausedFrom: startOf(from), lotIdsToFreeze: [lotId] }),
    );
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);

    const me = await c.client.get<{ data: { status: string; pauseState?: string } }>("/clients/me");
    expect(me.body.data).toMatchObject({ status: "PAUSED", pauseState: "SCHEDULED" });

    // Before the From date: normal portal, booking still works and charges a credit.
    const before = await book(c.client, earliest.id);
    expect(before.status, before.rawText.slice(0, 200)).toBe(200);

    // On/after it: refused.
    if (later) {
      const after = await book(c.client, later.id);
      expect(after.status, after.rawText.slice(0, 200)).toBe(403);
      expect(after.rawText).toMatch(/paused/i);
    }

    // Cancelling a scheduled pause = resume: ACTIVE again, nothing lost.
    expect((await lifecycle.resume(owner.client, c.clientId)).status).toBe(200);
    const active = await c.client.get<{ data: { status: string; pauseState?: string } }>("/clients/me");
    expect(active.body.data.status).toBe("ACTIVE");
  }, 120_000);
});
