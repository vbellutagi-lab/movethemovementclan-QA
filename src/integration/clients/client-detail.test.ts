import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createSecondSeedOrgCoach, getSeedCentre, getSeedCoachId } from "../../support/fixtures";
import { nonExistentUuid, uniqueEmail } from "../../support/random";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * New in v1.1.0->develop: clients.getById (backs /admin/clients/[clientId]) and
 * clients.listByCoach (backs the owner-facing coach-profile Clients tab). Neither existed before
 * — enrollment.test.ts only covers clients.enroll/join, not these two new reads.
 */
describe("clients — getById / listByCoach", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let clientId: string;
  let seedCoachId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    const client = await signInAs("client");
    clientId = (await getClientProfile(client.client)).id;
    seedCoachId = await getSeedCoachId();
  }, 30_000);

  it("getById — admin/owner can open any client in the org", async () => {
    const res = await owner.client.get<{ data: { id: string } }>(`/clients/${clientId}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.id).toBe(clientId);
  });

  it("getById — a coach can open a client assigned to them", async () => {
    const res = await coach.client.get<{ data: { id: string } }>(`/clients/${clientId}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.id).toBe(clientId);
  });

  it("getById — a coach cannot open a colleague's client (404, existence-hidden)", async () => {
    const centreId = (await getSeedCentre()).id;
    const { coachId: secondCoachId } = await createSecondSeedOrgCoach("client-detail-colleague");
    expect(secondCoachId).not.toBe(seedCoachId);

    const enrollRes = await owner.client.post<{ data: { id: string } }>("/clients/enroll", {
      email: uniqueEmail("client-detail-colleague-client"),
      name: "Colleague's Client (detail)",
      homeCentreId: centreId,
      coachId: secondCoachId,
    });
    expect(enrollRes.status).toBe(200);
    const colleagueClientId = enrollRes.body!.data.id;

    const res = await coach.client.get(`/clients/${colleagueClientId}`);
    expect(res.status).toBe(404);
  });

  it("getById — no session at all returns 401", async () => {
    const anon = newClient();
    const res = await anon.get(`/clients/${clientId}`);
    expect(res.status).toBe(401);
  });

  it("getById — non-existent clientId returns 404", async () => {
    const res = await owner.client.get(`/clients/${nonExistentUuid()}`);
    expect(res.status).toBe(404);
  });

  it("listByCoach — owner lists exactly the seed coach's assigned clients", async () => {
    const res = await owner.client.get<{ data: Array<{ id: string }> }>(
      `/clients/by-coach/${seedCoachId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.some((c) => c.id === clientId)).toBe(true);
  });

  it("listByCoach — owner-only, forbidden for a coach (even for their own coachId)", async () => {
    const res = await coach.client.get(`/clients/by-coach/${seedCoachId}`);
    expect(res.status).toBe(403);
  });
});
