import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { getSeedCentre, getSeedCoachId } from "../../support/fixtures";
import {
  LifecycleCleanup,
  balances,
  book,
  clientStatus,
  createLifecycleClient,
  createLifecycleCoach,
  enrollExistingUserAsClient,
  grantCredits,
  istDate,
  lifecycle,
  lotsFor,
  seedBookableSessions,
  trySignIn,
} from "../../support/lifecycle";
import { env } from "../../support/env";
import { waitForMessage } from "../../support/mailpit";
import { signInAs, type SignedInSession } from "../../support/test-users";

/**
 * member-lifecycle-e2e.md §5 (archive client), §6 (restore client) and the identity-guard parts
 * of §13. Archiving bans the whole login, so every case uses a throwaway user — never a seed one.
 */
describe("member lifecycle — client archive / restore (§5, §6, §13)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let seedCoachId: string;
  let creditType: string;
  let sessionIds: string[];

  beforeAll(async () => {
    owner = await signInAs("owner");
    seedCoachId = await getSeedCoachId();
    const sessions = await seedBookableSessions(cleanup, 2);
    sessionIds = sessions.map((s) => s.id);
    creditType = sessions[0]!.creditType;
  }, 60_000);

  afterAll(() => cleanup.run());

  const archive = (clientId: string, extra: Record<string, unknown> = {}) =>
    lifecycle.archiveClient(owner.client, {
      clientId,
      reason: "QA moved cities",
      bookingDecisions: [],
      ...extra,
    });

  it("CA-01..CA-03/CA-06/CA-16 — archive cancels bookings (per decision), keeps data, bans the login and kills the live session", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-arch-happy"));
    const lotId = await grantCredits(c.clientId, creditType, 3);
    const booking = await book(c.client, sessionIds[0]!);
    expect(booking.status).toBe(200);
    const bookingId = booking.body.data.id;

    const res = await archive(c.clientId, {
      bookingDecisions: [{ bookingId, action: "CANCEL_AND_FREEZE" }],
    });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    expect(await clientStatus(c.clientId)).toBe("ARCHIVED");

    // Credit returned to the lot and NOT frozen by archive (CA-06); data intact (CA-16).
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 3, frozen: 0 });
    expect((await lotsFor(c.clientId)).find((l) => l.id === lotId)?.granted).toBe(3);

    // CA-02/CA-03: Better Auth ban — a fresh sign-in is refused.
    expect(await trySignIn(c.email, c.password)).toBe(false);

    // CA-05/A-05: the session cookie they already hold is refused on identity-resolving calls.
    const me = await c.client.get("/clients/me");
    expect(me.status, me.rawText.slice(0, 200)).toBe(403);
    const sessionsCall = await c.client.get("/sessions");
    expect([401, 403]).toContain(sessionsCall.status);
  }, 90_000);

  it("CA-03 — the blocked sign-in message is friendly and never says 'banned'", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-arch-msg"));
    await archive(c.clientId);
    const anon = newClient();
    const res = await anon.authPost<{ message?: string }>("/sign-in/email", {
      email: c.email,
      password: c.password,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // `code` is machine-readable; only the human `message` is shown to the user.
    expect(res.body?.message).toMatch(/can't sign in to this account right now/i);
    expect(res.body?.message).not.toMatch(/banned/i);
  }, 60_000);

  it("CA-08/CA-11 — archiving twice is 409; a blank reason is 400", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-arch-twice"));
    expect((await archive(c.clientId, { reason: "  " })).status).toBe(400);
    expect((await archive(c.clientId)).status).toBe(200);
    expect((await archive(c.clientId)).status).toBe(409);
  }, 60_000);

  it("CA-07/RC-09 — a PAUSED client can be archived; restoring releases the held lots without extending expiry", async () => {
    const expiresAt = new Date(Date.now() + 25 * 86_400_000).toISOString();
    const c = cleanup.trackClient(await createLifecycleClient("lc-arch-paused"));
    const lotId = await grantCredits(c.clientId, creditType, 2, { expiresAt });
    expect(
      (
        await lifecycle.pause(owner.client, {
          clientId: c.clientId,
          reason: "QA",
          pausedFrom: istDate(),
          lotIdsToFreeze: [lotId],
          bookingDecisions: [],
        })
      ).status,
    ).toBe(200);
    expect(await balances(c.clientId, creditType)).toEqual({ balance: 0, frozen: 2 });
    const expiryBefore = (await lotsFor(c.clientId)).find((l) => l.id === lotId)!.expiresAt;

    expect((await archive(c.clientId)).status).toBe(200);
    const restored = await lifecycle.restoreClient(owner.client, {
      clientId: c.clientId,
      newCoachId: seedCoachId,
      lotDecisions: [{ lotId, action: "KEEP" }],
    });
    expect(restored.status, restored.rawText.slice(0, 300)).toBe(200);

    expect(await balances(c.clientId, creditType)).toEqual({ balance: 2, frozen: 0 });
    expect((await lotsFor(c.clientId)).find((l) => l.id === lotId)!.expiresAt).toBe(expiryBefore);
  }, 90_000);

  it("RC-01/RC-02/A-04 — restore re-assigns the coach, unbans, and the OLD password works again", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-restore"));
    await archive(c.clientId);
    expect(await trySignIn(c.email, c.password)).toBe(false);

    const res = await lifecycle.restoreClient(owner.client, {
      clientId: c.clientId,
      newCoachId: seedCoachId,
      lotDecisions: [],
    });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    expect(await clientStatus(c.clientId)).toBe("ACTIVE");

    expect(await trySignIn(c.email, c.password)).toBe(true);
    const detail = await owner.client.get<{ data: { coachId: string } }>(`/clients/${c.clientId}`);
    expect(detail.body.data.coachId).toBe(seedCoachId);
  }, 90_000);

  it("RC-03 — a lot marked 'Expire now' becomes unusable but keeps its remaining count", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-restore-expire"));
    const lotId = await grantCredits(c.clientId, creditType, 2);
    await archive(c.clientId);
    const res = await lifecycle.restoreClient(owner.client, {
      clientId: c.clientId,
      newCoachId: seedCoachId,
      lotDecisions: [{ lotId, action: "EXPIRE" }],
    });
    expect(res.status).toBe(200);
    const lot = (await lotsFor(c.clientId)).find((l) => l.id === lotId)!;
    expect(lot.remaining).toBe(2);
    expect(new Date(lot.expiresAt!).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await balances(c.clientId, creditType)).balance).toBe(0);
  }, 90_000);

  it("RC-06/RC-07/RC-08 — restore of a non-archived client is 409; unknown coach 404; foreign lot 400", async () => {
    const a = cleanup.trackClient(await createLifecycleClient("lc-restore-bad-a"));
    const b = cleanup.trackClient(await createLifecycleClient("lc-restore-bad-b"));
    const foreignLot = await grantCredits(b.clientId, creditType, 1);

    const active = await lifecycle.restoreClient(owner.client, {
      clientId: a.clientId,
      newCoachId: seedCoachId,
      lotDecisions: [],
    });
    expect(active.status).toBe(409);

    await archive(a.clientId);
    const noCoach = await lifecycle.restoreClient(owner.client, {
      clientId: a.clientId,
      newCoachId: "00000000-0000-4000-8000-000000000000",
      lotDecisions: [],
    });
    expect(noCoach.status).toBe(404);
    const badLot = await lifecycle.restoreClient(owner.client, {
      clientId: a.clientId,
      newCoachId: seedCoachId,
      lotDecisions: [{ lotId: foreignLot, action: "EXPIRE" }],
    });
    expect(badLot.status).toBe(400);
    expect(await clientStatus(a.clientId)).toBe("ARCHIVED");
  }, 90_000);

  it("RC-07/L-08 — restoring onto an ARCHIVED coach is refused (404)", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-arch-coach"));
    const c = cleanup.trackClient(await createLifecycleClient("lc-restore-archcoach"));
    await archive(c.clientId);
    expect(
      (
        await lifecycle.archiveCoach(owner.client, {
          coachId: coach.coachId,
          reason: "QA",
          clientAssignments: [],
          sessionsPolicy: { mode: "CANCEL" },
        })
      ).status,
    ).toBe(200);
    const res = await lifecycle.restoreClient(owner.client, {
      clientId: c.clientId,
      newCoachId: coach.coachId,
      lotDecisions: [],
    });
    expect(res.status).toBe(404);
  }, 120_000);

  it("CA-14/CA-17/G-03 — archived users get no password-reset email (neutral response, nothing in the mailbox)", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-arch-mail"));
    await archive(c.clientId);
    const since = Date.now();
    const anon = newClient();
    // Better Auth renamed this route across versions; accept whichever this build serves.
    let res = await anon.authPost("/request-password-reset", { email: c.email, redirectTo: env.webBaseUrl });
    if (res.status === 404) res = await anon.authPost("/forget-password", { email: c.email, redirectTo: env.webBaseUrl });
    expect(res.status, res.rawText.slice(0, 200)).toBe(200);

    await expect(
      waitForMessage(c.email, { subjectMatch: /reset|password/i, sinceMs: since, timeoutMs: 4_000 }),
    ).rejects.toThrow(/No message arrived/);
  }, 60_000);

  it("L-12/L-13 — staff-enrolling the email of an ARCHIVED or PAUSED client is refused, no duplicate profile, no unban", async () => {
    const centre = await getSeedCentre();
    const archived = cleanup.trackClient(await createLifecycleClient("lc-enroll-arch"));
    const paused = cleanup.trackClient(await createLifecycleClient("lc-enroll-paused"));
    await archive(archived.clientId);
    await lifecycle.pause(owner.client, {
      clientId: paused.clientId,
      reason: "QA",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    });

    for (const who of [archived, paused]) {
      const res = await owner.client.post("/clients/enroll", {
        email: who.email,
        name: "dup",
        homeCentreId: centre.id,
        coachId: seedCoachId,
      });
      expect(res.status, `${who.email}: ${res.rawText.slice(0, 160)}`).toBe(409);
    }
    expect(await trySignIn(archived.email, archived.password)).toBe(false);
    expect(await clientStatus(archived.clientId)).toBe("ARCHIVED");
  }, 90_000);

  it("CA-09/CA-10/RC-12 — archiving the CLIENT profile of a user who is also a live coach does not ban them", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-dual"));
    const enrol = await enrollExistingUserAsClient(coach.session.email, coach.name, seedCoachId);
    expect(enrol.status, enrol.rawText.slice(0, 200)).toBe(200);
    const profile = await coach.session.client.get<{ data: { id: string } }>("/clients/me");
    const clientId = profile.body.data.id;
    cleanup.trackClient({
      client: coach.session.client,
      email: coach.session.email,
      password: coach.password,
      userId: coach.userId,
      clientId,
    });

    const res = await archive(clientId);
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    expect(await clientStatus(clientId)).toBe("ARCHIVED");
    // Still has a live role → login must keep working.
    expect(await trySignIn(coach.session.email, coach.password)).toBe(true);

    const restore = await lifecycle.restoreClient(owner.client, {
      clientId,
      newCoachId: seedCoachId,
      lotDecisions: [],
    });
    expect(restore.status).toBe(200);
    expect(await trySignIn(coach.session.email, coach.password)).toBe(true);
  }, 120_000);

  it("RC-13 / lifecycle repeats — pause → resume → archive → restore → pause works end to end", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-cycle"));
    const pause = () =>
      lifecycle.pause(owner.client, {
        clientId: c.clientId,
        reason: "QA",
        pausedFrom: istDate(),
        lotIdsToFreeze: [],
        bookingDecisions: [],
      });
    expect((await pause()).status).toBe(200);
    expect((await lifecycle.resume(owner.client, c.clientId)).status).toBe(200);
    expect((await archive(c.clientId)).status).toBe(200);
    expect(
      (
        await lifecycle.restoreClient(owner.client, {
          clientId: c.clientId,
          newCoachId: seedCoachId,
          lotDecisions: [],
        })
      ).status,
    ).toBe(200);
    expect((await pause()).status).toBe(200);
    expect(await clientStatus(c.clientId)).toBe("PAUSED");
  }, 90_000);
});
