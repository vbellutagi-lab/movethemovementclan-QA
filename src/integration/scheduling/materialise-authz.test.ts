import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { signInAs, type SignedInSession } from "../../support/test-users";

describe("scheduling.materialise — authorization (docs/scenarios.md §7.14)", () => {
  let coach: SignedInSession;
  let staff: SignedInSession;

  beforeAll(async () => {
    coach = await signInAs("coach");
    staff = await signInAs("staff");
  }, 30_000);

  it("materialising sessions as a non-admin org member (coach) is forbidden", async () => {
    const res = await coach.client.post("/scheduling/materialise", {});
    expect(res.status).toBe(403);
  });

  it("materialising sessions as a non-admin org member (staff) is forbidden", async () => {
    const res = await staff.client.post("/scheduling/materialise", {});
    expect(res.status).toBe(403);
  });

  it("materialising sessions with no session at all returns 401", async () => {
    const anon = newClient();
    const res = await anon.post("/scheduling/materialise", {});
    expect(res.status).toBe(401);
  });
});
