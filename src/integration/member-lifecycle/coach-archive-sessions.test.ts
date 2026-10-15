import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBookableSessions } from "../../support/booking-helpers";
import { getSeedCoachId } from "../../support/fixtures";
import { signInAs, type SignedInSession } from "../../support/test-users";
import {
  LifecycleCleanup,
  balances,
  book,
  createLifecycleClient,
  createLifecycleCoach,
  grantCredits,
  istDate,
  lifecycle,
} from "../../support/lifecycle";

const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

interface OversightSession {
  sessionId: string;
  coachId: string;
  status: string;
  creditType: string;
  confirmedCount: number;
  startsAt: string;
}

/**
 * member-lifecycle-e2e.md §7.3 (CH-05, CH-44) — the real session hand-over / cancel paths that the
 * plan's G-14 says had only ever run against fakes. Each test builds a throwaway coach with a
 * weekly class, materialises it into real sessions and books a throwaway client onto one.
 */
describe("member lifecycle — coach archive moves real sessions (§7.3)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let seedCoachId: string;
  let base: { sessionTypeId: string; centreId: string };

  beforeAll(async () => {
    owner = await signInAs("owner");
    seedCoachId = await getSeedCoachId();
    // Borrow the session type + centre of a seeded group class (capacity > 1, i.e. not a 1:1 PT
    // slot, which only the coach's own clients could book).
    const list = await owner.client.get<{
      data: { sessionTypeId: string; centreId: string; capacity: number }[];
    }>("/class-templates");
    const group = list.body.data.find((t) => t.capacity > 1);
    if (!group) throw new Error("No seeded group class template to borrow — reseed.");
    base = { sessionTypeId: group.sessionTypeId, centreId: group.centreId };
  }, 60_000);

  afterAll(() => cleanup.run());

  /** A coach with a weekly class tomorrow, materialised, with one future session + one booking. */
  async function coachWithBookedSession(label: string, startTime: string) {
    const coach = cleanup.trackCoach(await createLifecycleCoach(label));
    const tpl = await owner.client.post<{ data: { id: string } }>("/class-templates", {
      ...base,
      coachId: coach.coachId,
      weekday: WEEKDAYS[(new Date().getDay() + 1) % 7],
      startTime,
      capacity: 3,
      activeFrom: istDate(),
    });
    expect(tpl.status, tpl.rawText.slice(0, 300)).toBe(200);
    cleanup.trackTemplate(tpl.body.data.id);
    expect((await owner.client.post("/scheduling/materialise", {})).status).toBe(200);

    // booking-oversight/list-sessions only returns sessions that already have bookings, so find
    // the fresh one through the (read-only) bookable list the seed client sees.
    const bookable = await listBookableSessions((await signInAs("client")).client);
    const found = bookable
      .filter((s) => s.coachId === coach.coachId)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    if (!found) throw new Error("materialise produced no session for the throwaway coach");
    const session: OversightSession = {
      sessionId: found.id,
      coachId: found.coachId,
      status: "SCHEDULED",
      creditType: found.creditType,
      confirmedCount: found.bookedCount,
      startsAt: found.startsAt,
    };

    const client = cleanup.trackClient(await createLifecycleClient(`${label}-c`, coach.coachId));
    await grantCredits(client.clientId, session.creditType, 2);
    const booking = await book(client.client, session.sessionId);
    expect(booking.status, booking.rawText.slice(0, 200)).toBe(200);
    return { coach, session, client, bookingId: booking.body.data.id };
  }

  const sessionById = async (id: string) =>
    (
      await owner.client.get<{ data: { sessions: OversightSession[] } }>(
        "/booking-oversight/list-sessions?when=upcoming&limit=100",
      )
    ).body.data.sessions.find((s) => s.sessionId === id);

  it("CH-02/CH-44 — HAND_OVER gives the future session to the new coach and leaves the booking untouched", async () => {
    const { coach, session, client } = await coachWithBookedSession("lc-ho", "04:12");
    const to = cleanup.trackCoach(await createLifecycleCoach("lc-ho-to"));

    const impact = (await lifecycle.coachImpact(owner.client, coach.coachId)).body.data;
    expect(impact.futureSessionCount).toBeGreaterThanOrEqual(1);

    const res = await lifecycle.archiveCoach(owner.client, {
      coachId: coach.coachId,
      reason: "QA hand over",
      clientAssignments: [{ clientId: client.clientId, newCoachId: to.coachId }],
      sessionsPolicy: { mode: "HAND_OVER", coachId: to.coachId },
    });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);

    const after = await sessionById(session.sessionId);
    expect(after?.coachId).toBe(to.coachId);
    expect(after?.status).toBe("SCHEDULED");
    expect(after?.confirmedCount).toBe(1); // the one booking made above is still there
  }, 240_000);

  it("CH-05 — CANCEL cancels the future session and refunds every booking unconditionally", async () => {
    const { coach, session, client } = await coachWithBookedSession("lc-cx", "04:22");
    const before = await balances(client.clientId, session.creditType);
    expect(before.balance).toBe(1); // 2 granted, 1 spent on the booking

    const res = await lifecycle.archiveCoach(owner.client, {
      coachId: coach.coachId,
      reason: "QA cancel",
      clientAssignments: [{ clientId: client.clientId, newCoachId: seedCoachId }],
      sessionsPolicy: { mode: "CANCEL" },
    });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);

    const gone = await sessionById(session.sessionId);
    // Either filtered out of "upcoming" or shown as CANCELLED — never still SCHEDULED.
    expect(gone === undefined || gone.status === "CANCELLED").toBe(true);
    expect((await balances(client.clientId, session.creditType)).balance).toBe(2);
  }, 240_000);
});
