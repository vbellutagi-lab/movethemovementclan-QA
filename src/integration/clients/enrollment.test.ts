import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createTenantOrg, getSeedCentre, getSeedCoachId } from "../../support/fixtures";
import { uniqueEmail as freshEmail } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

describe("clients — enrollment (docs/scenarios.md §7.1–7.5)", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let centreId: string;
  let coachId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    centreId = (await getSeedCentre()).id;
    coachId = await getSeedCoachId();
  }, 30_000);

  it("enrolls a new client by email as org admin — happy path", async () => {
    const res = await owner.client.post<{ data: { id: string; homeCentreId: string } }>(
      "/clients/enroll",
      { email: freshEmail("ce1"), name: "QA Enrollee", homeCentreId: centreId, coachId },
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.homeCentreId).toBe(centreId);
  });

  it("enrolling as a non-admin org member (coach) is forbidden", async () => {
    const res = await coach.client.post("/clients/enroll", {
      email: freshEmail("ce2"),
      name: "Should Not Enroll",
      homeCentreId: centreId,
      coachId,
    });
    expect(res.status).toBe(403);
  });

  it("enrolling into a centre from a DIFFERENT org is rejected — and indistinguishably from a bad centre id (anti-enumeration)", async () => {
    const { superadmin } = await createTenantOrg("enroll-cross-org");
    const res = await superadmin.client.post("/clients/enroll", {
      email: freshEmail("ce3"),
      name: "Wrong Org Centre",
      homeCentreId: centreId, // belongs to the SEED org, not superadmin's brand-new empty org
      coachId, // also a seed-org id — irrelevant, the centre check should reject first
    });
    expect(res.status).toBe(404);
  });

  it("self-service join when already enrolled returns a conflict, not a duplicate row", async () => {
    const client = await signInAs("client"); // already enrolled by the seed script
    const res = await client.client.post("/clients/join", { homeCentreId: centreId });
    expect(res.status).toBe(409);
  });

  it("enrolling with no session at all returns 401", async () => {
    const anon = newClient();
    const res = await anon.post("/clients/enroll", {
      email: freshEmail("ce6"),
      name: "Nobody",
      homeCentreId: centreId,
    });
    expect(res.status).toBe(401);
  });

  it("chain: an unrelated org's authenticated caller can discover the seed org's centre id via listCentres (docs/scenarios.md §1.9)", async () => {
    // organizations.listCentres is `protectedProcedure` only — any authenticated user, any org.
    const { superadmin } = await createTenantOrg("listcentres-probe");
    const res = await superadmin.client.get<{ data: { id: string; name: string }[] }>(
      "/organizations/move-dev/centres",
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.some((c) => c.id === centreId)).toBe(true);
  });
});
