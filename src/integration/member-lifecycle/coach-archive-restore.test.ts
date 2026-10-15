import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerifiedEnrolledClient, getSeedCentre, getSeedCoachId } from "../../support/fixtures";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";
import {
  LifecycleCleanup,
  clientStatus,
  coachStatus,
  createLifecycleClient,
  createLifecycleCoach,
  enrollExistingUserAsClient,
  istDate,
  lifecycle,
  trySignIn,
  type LifecycleCoach,
} from "../../support/lifecycle";
import { nonExistentUuid } from "../../support/random";

const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

interface TemplateRow {
  id: string;
  coachId: string;
  sessionTypeId: string;
  centreId: string;
}

/**
 * member-lifecycle-e2e.md §7 (archive coach), §8 (restore coach), plus the coach-picker and
 * auto-assign parts of §11/§12. Only throwaway coaches/clients/templates are archived — the seed
 * coaches (coach@, coach2@) are never touched, so other suites keep their fixtures.
 */
describe("member lifecycle — coach archive / restore (§7, §8, §11, §12)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let seedCoachId: string;
  let reference: TemplateRow;

  beforeAll(async () => {
    owner = await signInAs("owner");
    seedCoachId = await getSeedCoachId();
    const list = await owner.client.get<{ data: TemplateRow[] }>("/class-templates");
    const first = list.body?.data?.[0];
    if (!first) throw new Error("No class template to borrow sessionTypeId/centreId from — reseed.");
    reference = first;
  }, 60_000);

  afterAll(() => cleanup.run());

  const archiveCoach = (coachId: string, extra: Record<string, unknown> = {}) =>
    lifecycle.archiveCoach(owner.client, {
      coachId,
      reason: "QA leaving the studio",
      clientAssignments: [],
      sessionsPolicy: { mode: "CANCEL" },
      ...extra,
    });

  async function makeTemplate(coachId: string, startTime: string, weekdayOffset = 3) {
    const res = await owner.client.post<{ data: { id: string } }>("/class-templates", {
      sessionTypeId: reference.sessionTypeId,
      centreId: reference.centreId,
      coachId,
      weekday: WEEKDAYS[(new Date().getDay() + weekdayOffset) % 7],
      startTime,
      capacity: 3,
      activeFrom: istDate(),
    });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    cleanup.trackTemplate(res.body.data.id);
    return res.body.data.id;
  }

  const templates = async () =>
    (await owner.client.get<{ data: TemplateRow[] }>("/class-templates")).body.data;

  const detail = async (clientId: string) =>
    (await owner.client.get<{ data: { coachId: string; status: string } }>(`/clients/${clientId}`)).body
      .data;

  // ---------------------------------------------------------------- impact + validation

  it("CH-01/CH-08/CH-09 — impact lists live clients (ACTIVE + PAUSED, not ARCHIVED) and counts weekly classes", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-impact"));
    const active = cleanup.trackClient(await createLifecycleClient("lc-imp-active", coach.coachId));
    const paused = cleanup.trackClient(await createLifecycleClient("lc-imp-paused", coach.coachId));
    const gone = cleanup.trackClient(await createLifecycleClient("lc-imp-gone", coach.coachId));
    await lifecycle.pause(owner.client, {
      clientId: paused.clientId,
      reason: "QA",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    });
    await lifecycle.archiveClient(owner.client, { clientId: gone.clientId, reason: "QA", bookingDecisions: [] });
    await makeTemplate(coach.coachId, "04:11");

    const impact = (await lifecycle.coachImpact(owner.client, coach.coachId)).body.data;
    const byId = new Map(impact.clients.map((c) => [c.id, c.status]));
    expect(byId.get(active.clientId)).toBe("ACTIVE");
    expect(byId.get(paused.clientId)).toBe("PAUSED");
    expect(byId.has(gone.clientId)).toBe(false);
    expect(impact.templateCount).toBe(1);
    expect(impact.futureSessionCount).toBeGreaterThanOrEqual(0);
  }, 150_000);

  it("CH-20..CH-24/CH-34 — incomplete / foreign / self / unknown assignments and a blank reason are rejected and change nothing", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-validate"));
    const mine = cleanup.trackClient(await createLifecycleClient("lc-val-mine", coach.coachId));
    const other = cleanup.trackClient(await createLifecycleClient("lc-val-other")); // belongs to the seed coach

    // CH-21: client omitted
    expect((await archiveCoach(coach.coachId)).status).toBe(409);
    // CH-22: a client who isn't this coach's
    expect(
      (
        await archiveCoach(coach.coachId, {
          clientAssignments: [
            { clientId: mine.clientId, newCoachId: seedCoachId },
            { clientId: other.clientId, newCoachId: seedCoachId },
          ],
        })
      ).status,
    ).toBe(400);
    // CH-23: assign to the coach being archived
    expect(
      (
        await archiveCoach(coach.coachId, {
          clientAssignments: [{ clientId: mine.clientId, newCoachId: coach.coachId }],
        })
      ).status,
    ).toBe(400);
    // CH-24: non-existent replacement
    expect(
      (
        await archiveCoach(coach.coachId, {
          clientAssignments: [{ clientId: mine.clientId, newCoachId: nonExistentUuid() }],
        })
      ).status,
    ).toBe(404);
    // CH-34: blank reason
    expect(
      (
        await archiveCoach(coach.coachId, {
          reason: " ",
          clientAssignments: [{ clientId: mine.clientId, newCoachId: seedCoachId }],
        })
      ).status,
    ).toBe(400);

    expect(await coachStatus(coach.coachId)).toBe("ACTIVE");
    expect((await detail(mine.clientId)).coachId).toBe(coach.coachId);
    expect(await trySignIn(coach.session.email, coach.password)).toBe(true);
  }, 150_000);

  it("CH-29 — a coach who is also a live client cannot be archived (403) and nothing changes", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-dual-coach"));
    const enrol = await enrollExistingUserAsClient(coach.session.email, coach.name, seedCoachId);
    expect(enrol.status, enrol.rawText.slice(0, 200)).toBe(200);
    const clientId = (await getClientProfile(coach.session.client)).id;
    cleanup.trackClient({
      client: coach.session.client,
      email: coach.session.email,
      password: coach.password,
      userId: coach.userId,
      clientId,
    });

    const res = await archiveCoach(coach.coachId);
    expect(res.status, res.rawText.slice(0, 200)).toBe(403);
    expect(await coachStatus(coach.coachId)).toBe("ACTIVE");
  }, 120_000);

  it("CH-49 — handing weekly classes to a coach with a same-day-and-time class is refused up front; the coach stays ACTIVE and can sign in", async () => {
    const from = cleanup.trackCoach(await createLifecycleCoach("lc-clash-from"));
    const to = cleanup.trackCoach(await createLifecycleCoach("lc-clash-to"));
    const tFrom = await makeTemplate(from.coachId, "04:21");
    await makeTemplate(to.coachId, "04:21"); // identical weekday + time

    const res = await archiveCoach(from.coachId, { sessionsPolicy: { mode: "HAND_OVER", coachId: to.coachId } });
    expect(res.status, res.rawText.slice(0, 300)).toBe(409);
    expect(res.rawText).toMatch(/weekly class/i);

    expect(await coachStatus(from.coachId)).toBe("ACTIVE");
    expect((await templates()).find((t) => t.id === tFrom)?.coachId).toBe(from.coachId);
    expect(await trySignIn(from.session.email, from.password)).toBe(true);
  }, 150_000);

  // ---------------------------------------------------------------- happy paths

  it("CH-02..CH-04/CH-48/CH-30/G-04 — archive with HAND_OVER reassigns clients, moves weekly classes, bans the login; archiving again is 409", async () => {
    const from = cleanup.trackCoach(await createLifecycleCoach("lc-hand-from"));
    const to = cleanup.trackCoach(await createLifecycleCoach("lc-hand-to"));
    const c1 = cleanup.trackClient(await createLifecycleClient("lc-hand-c1", from.coachId));
    const c2 = cleanup.trackClient(await createLifecycleClient("lc-hand-c2", from.coachId));
    const tpl = await makeTemplate(from.coachId, "04:31");

    const res = await archiveCoach(from.coachId, {
      clientAssignments: [
        { clientId: c1.clientId, newCoachId: to.coachId },
        { clientId: c2.clientId, newCoachId: seedCoachId },
      ],
      sessionsPolicy: { mode: "HAND_OVER", coachId: to.coachId },
    });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);

    expect(await coachStatus(from.coachId)).toBe("ARCHIVED");
    expect((await detail(c1.clientId)).coachId).toBe(to.coachId);
    expect((await detail(c2.clientId)).coachId).toBe(seedCoachId);
    expect((await templates()).find((t) => t.id === tpl)?.coachId).toBe(to.coachId);

    // Better Auth ban: fresh sign-in refused; held cookie refused too (CH-03).
    expect(await trySignIn(from.session.email, from.password)).toBe(false);
    const held = await from.session.client.get("/coaches/complete-profile");
    expect([401, 403, 404, 405]).toContain(held.status);

    // Visible as ARCHIVED to admins; never listed as ACTIVE.
    const list = await owner.client.get<{ data: { id: string; status: string }[] }>("/coaches");
    expect(list.body.data.find((c) => c.id === from.coachId)?.status).toBe("ARCHIVED");

    expect((await archiveCoach(from.coachId)).status).toBe(409);
  }, 240_000);

  it("CH-48 — archive with CANCEL switches the coach's weekly classes off", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-cancel-coach"));
    const tpl = await makeTemplate(coach.coachId, "04:41");
    expect((await templates()).some((t) => t.id === tpl)).toBe(true);

    const res = await archiveCoach(coach.coachId, { sessionsPolicy: { mode: "CANCEL" } });
    expect(res.status, res.rawText.slice(0, 300)).toBe(200);
    expect((await templates()).some((t) => t.id === tpl && t.coachId === coach.coachId)).toBe(false);
  }, 150_000);

  // ---------------------------------------------------------------- archived coach is unusable everywhere

  describe("an ARCHIVED coach cannot be assigned anything (G-01, S-05..S-08, L-03, L-07, L-08)", () => {
    let archived: LifecycleCoach;

    beforeAll(async () => {
      archived = cleanup.trackCoach(await createLifecycleCoach("lc-archived-pick"));
      const res = await archiveCoach(archived.coachId);
      expect(res.status, res.rawText.slice(0, 200)).toBe(200);
    }, 150_000);

    it("L-07 — staff-enrolling a client under an archived coach is 404", async () => {
      const centre = await getSeedCentre();
      const res = await owner.client.post("/clients/enroll", {
        email: `lc-arch-pick+${Date.now()}@move-qa.test`,
        name: "QA",
        homeCentreId: centre.id,
        coachId: archived.coachId,
      });
      expect(res.status, res.rawText.slice(0, 200)).toBe(404);
    });

    it("L-08 — reassigning a client to an archived coach is 404", async () => {
      const c = cleanup.trackClient(await createLifecycleClient("lc-reassign"));
      const res = await owner.client.post("/clients/reassign-coach", {
        clientId: c.clientId,
        newCoachId: archived.coachId,
      });
      expect(res.status, res.rawText.slice(0, 200)).toBe(404);
      expect((await detail(c.clientId)).coachId).toBe(seedCoachId);
    }, 90_000);

    it("S-05/S-06 — creating a weekly class with an archived coach is refused", async () => {
      const res = await owner.client.post("/class-templates", {
        sessionTypeId: reference.sessionTypeId,
        centreId: reference.centreId,
        coachId: archived.coachId,
        weekday: "MONDAY",
        startTime: "04:51",
        capacity: 3,
        activeFrom: istDate(),
      });
      if (res.status === 200) {
        cleanup.trackTemplate((res.body as { data: { id: string } }).data.id);
      }
      expect(res.status, res.rawText.slice(0, 200)).toBeGreaterThanOrEqual(400);
    });

    it("L-03 — a self-serve join after the archive is never auto-assigned the archived coach", async () => {
      const fresh = await createVerifiedEnrolledClient("lc-autoassign", {
        defaultHeaders: { "x-forwarded-for": `198.51.100.${100 + Math.floor(Math.random() * 100)}` },
      });
      const profile = await getClientProfile(fresh.client);
      cleanup.trackClient({
        client: fresh.client,
        email: fresh.email,
        password: fresh.password,
        userId: profile.userId,
        clientId: profile.id,
      });
      expect(profile.assignedCoachId).not.toBe(archived.coachId);
      expect(profile.assignedCoachId).toBeTruthy();
    }, 90_000);

    it("CHR-01/CHR-02/CHR-06/CHR-09 — restore re-enables the coach and login, moves nothing back, and a second restore is 409; archive → restore → archive repeats", async () => {
      const res = await lifecycle.restoreCoach(owner.client, archived.coachId);
      expect(res.status, res.rawText.slice(0, 200)).toBe(200);
      expect(await coachStatus(archived.coachId)).toBe("ACTIVE");
      expect(await trySignIn(archived.session.email, archived.password)).toBe(true);
      expect((await lifecycle.coachImpact(owner.client, archived.coachId)).body.data.clients).toHaveLength(0);

      expect((await lifecycle.restoreCoach(owner.client, archived.coachId)).status).toBe(409);
      expect((await archiveCoach(archived.coachId)).status).toBe(200);
      expect(await coachStatus(archived.coachId)).toBe("ARCHIVED");
    }, 120_000);
  });

  it("CHR-02 — restoring a coach does not pull clients back from the coaches they were moved to", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-restore-noreturn"));
    const c = cleanup.trackClient(await createLifecycleClient("lc-noreturn", coach.coachId));
    await archiveCoach(coach.coachId, {
      clientAssignments: [{ clientId: c.clientId, newCoachId: seedCoachId }],
    });
    expect((await lifecycle.restoreCoach(owner.client, coach.coachId)).status).toBe(200);
    expect((await detail(c.clientId)).coachId).toBe(seedCoachId);
    expect(await clientStatus(c.clientId)).toBe("ACTIVE");
  }, 150_000);
});
