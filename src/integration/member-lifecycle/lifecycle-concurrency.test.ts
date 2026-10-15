import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSeedCoachId } from "../../support/fixtures";
import {
  LifecycleCleanup,
  createLifecycleClient,
  createLifecycleCoach,
  istDate,
  lifecycle,
} from "../../support/lifecycle";
import { signInAs, type SignedInSession } from "../../support/test-users";

/**
 * member-lifecycle-e2e.md CP-51/CP-52 generalised: every lifecycle transition fired twice at the
 * same moment must have exactly one winner (200) and one 409 — never two commits.
 */
describe("member lifecycle — concurrent identical transitions (CP-51/CP-52)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let seedCoachId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    seedCoachId = await getSeedCoachId();
  }, 60_000);

  afterAll(() => cleanup.run());

  const twice = async (call: () => Promise<{ status: number }>) =>
    (await Promise.all([call(), call()])).map((r) => r.status).sort();

  it("resume-client ×2 → one 200, one 409", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-race-resume"));
    await lifecycle.pause(owner.client, {
      clientId: c.clientId,
      reason: "QA",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    });
    expect(await twice(() => lifecycle.resume(owner.client, c.clientId))).toEqual([200, 409]);
  }, 60_000);

  it("archive-client ×2 → one 200, one 409", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-race-archive"));
    expect(
      await twice(() =>
        lifecycle.archiveClient(owner.client, { clientId: c.clientId, reason: "QA", bookingDecisions: [] }),
      ),
    ).toEqual([200, 409]);
  }, 60_000);

  it("restore-client ×2 → one 200, one 409", async () => {
    const c = cleanup.trackClient(await createLifecycleClient("lc-race-restore"));
    await lifecycle.archiveClient(owner.client, { clientId: c.clientId, reason: "QA", bookingDecisions: [] });
    expect(
      await twice(() =>
        lifecycle.restoreClient(owner.client, { clientId: c.clientId, newCoachId: seedCoachId, lotDecisions: [] }),
      ),
    ).toEqual([200, 409]);
  }, 60_000);

  it("archive-coach ×2 → one 200, one 409", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-race-archcoach"));
    expect(
      await twice(() =>
        lifecycle.archiveCoach(owner.client, {
          coachId: coach.coachId,
          reason: "QA",
          clientAssignments: [],
          sessionsPolicy: { mode: "CANCEL" },
        }),
      ),
    ).toEqual([200, 409]);
  }, 90_000);

  it("restore-coach ×2 → one 200, one 409", async () => {
    const coach = cleanup.trackCoach(await createLifecycleCoach("lc-race-restcoach"));
    await lifecycle.archiveCoach(owner.client, {
      coachId: coach.coachId,
      reason: "QA",
      clientAssignments: [],
      sessionsPolicy: { mode: "CANCEL" },
    });
    expect(await twice(() => lifecycle.restoreCoach(owner.client, coach.coachId))).toEqual([200, 409]);
  }, 90_000);
});
