import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createUnrelatedOrgAdmin } from "../../support/fixtures";
import {
  LifecycleCleanup,
  createLifecycleClient,
  lifecycle,
  istDate,
  type LifecycleClient,
} from "../../support/lifecycle";
import { getSeedCoachId } from "../../support/fixtures";
import { nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

/**
 * member-lifecycle-e2e.md §2 (P-xx) and §20 (X-xx): only owner/admin may drive pause / archive /
 * restore. Every denial is asserted against a throwaway client so a bug that lets a call through
 * can never hurt a shared seed identity; nothing here is expected to change state.
 */
describe("member lifecycle — authorization & tenant isolation (§2, §20)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let staff: SignedInSession;
  let coach: SignedInSession;
  let target: LifecycleClient;
  let seedCoachId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    staff = await signInAs("staff");
    coach = await signInAs("coach");
    seedCoachId = await getSeedCoachId();
    target = cleanup.trackClient(await createLifecycleClient("lc-authz"));
  }, 90_000);

  afterAll(() => cleanup.run());

  const mutations = (clientId: string, coachId: string) => ({
    "pause-client": {
      clientId,
      reason: "QA",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    },
    "resume-client": { clientId },
    "archive-client": { clientId, reason: "QA", bookingDecisions: [] },
    "restore-client": { clientId, newCoachId: coachId, lotDecisions: [] },
    "archive-coach": {
      coachId,
      reason: "QA",
      clientAssignments: [],
      sessionsPolicy: { mode: "CANCEL" },
    },
    "restore-coach": { coachId },
  });

  it("P-06 — no session at all → 401 on every procedure", async () => {
    const anon = newClient();
    for (const [path, body] of Object.entries(mutations(target.clientId, seedCoachId))) {
      expect((await anon.post(`/member-lifecycle/${path}`, body)).status, path).toBe(401);
    }
    expect((await anon.get(`/member-lifecycle/coach-impact?coachId=${seedCoachId}`)).status).toBe(401);
    expect((await anon.get("/member-lifecycle/cancellation-policy")).status).toBe(401);
  });

  it("P-03/P-05 — a coach (org role member) is 403 on every procedure and nothing changes", async () => {
    for (const [path, body] of Object.entries(mutations(target.clientId, seedCoachId))) {
      expect((await coach.client.post(`/member-lifecycle/${path}`, body)).status, path).toBe(403);
    }
    expect((await lifecycle.coachImpact(coach.client, seedCoachId)).status).toBe(403);
    expect((await lifecycle.cancellationPolicy(coach.client)).status).toBe(403);

    const after = await owner.client.get<{ data: { status: string } }>(`/clients/${target.clientId}`);
    expect(after.body.data.status).toBe("ACTIVE");
  });

  it("P-04 — a client can never pause / archive themselves (403) and stays ACTIVE", async () => {
    for (const [path, body] of Object.entries(mutations(target.clientId, seedCoachId))) {
      expect((await target.client.post(`/member-lifecycle/${path}`, body)).status, path).toBe(403);
    }
    expect((await lifecycle.coachImpact(target.client, seedCoachId)).status).toBe(403);
    const me = await target.client.get<{ data: { status: string } }>("/clients/me");
    expect(me.body.data.status).toBe("ACTIVE");
  });

  it("P-02 — an org ADMIN (staff@) is allowed to read the read-only previews", async () => {
    const impact = await lifecycle.coachImpact(staff.client, seedCoachId);
    expect(impact.status).toBe(200);
    expect((await lifecycle.cancellationPolicy(staff.client)).status).toBe(200);
  });

  it("P-02 — an ADMIN can pause and resume a client (owner and admin have full authority)", async () => {
    const pause = await lifecycle.pause(staff.client, {
      clientId: target.clientId,
      reason: "QA admin pause",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    });
    expect(pause.status, pause.rawText.slice(0, 200)).toBe(200);
    const resume = await lifecycle.resume(staff.client, target.clientId);
    expect(resume.status, resume.rawText.slice(0, 200)).toBe(200);
  });

  it("P-12/P-13 — admin may call clients.listByCoach / coaches.getById; a coach may not", async () => {
    expect((await staff.client.get(`/clients/by-coach/${seedCoachId}`)).status).toBe(200);
    expect((await staff.client.get(`/coaches/${seedCoachId}`)).status).toBe(200);
    expect((await coach.client.get(`/clients/by-coach/${seedCoachId}`)).status).toBe(403);
    expect((await coach.client.get(`/coaches/${seedCoachId}`)).status).toBe(403);
  });

  it("CP-36 — malformed ids are 400 and unknown ids are 404 (never 500)", async () => {
    const bad = await lifecycle.pause(owner.client, {
      clientId: "not-a-uuid",
      reason: "QA",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    });
    expect(bad.status).toBe(400);
    expect((await lifecycle.resume(owner.client, nonExistentUuid())).status).toBe(404);
    expect((await lifecycle.restoreCoach(owner.client, nonExistentUuid())).status).toBe(404);
    expect((await lifecycle.coachImpact(owner.client, nonExistentUuid())).status).toBe(404);
  });

  it("X-01/X-02/CP-35/CR-11/CA-12/CHR-07 — an admin of ANOTHER org gets 404 for this org's ids, identical to a non-existent id", async () => {
    const { session } = await createUnrelatedOrgAdmin("staff", "admin");
    for (const [path, body] of Object.entries(mutations(target.clientId, seedCoachId))) {
      const res = await session.client.post(`/member-lifecycle/${path}`, body);
      expect(res.status, `${path}: ${res.rawText.slice(0, 160)}`).toBe(404);
    }
    expect((await lifecycle.coachImpact(session.client, seedCoachId)).status).toBe(404);

    // …and nothing in the real org changed.
    const after = await owner.client.get<{ data: { status: string } }>(`/clients/${target.clientId}`);
    expect(after.body.data.status).toBe("ACTIVE");
    const coachAfter = await owner.client.get<{ data: { status: string } }>(`/coaches/${seedCoachId}`);
    expect(coachAfter.body.data.status).toBe("ACTIVE");
  }, 60_000);
});
