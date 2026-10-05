import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createUnrelatedOrgAdmin } from "../../support/fixtures";
import { createCreditType, listCreditTypes, retireCreditType } from "../../support/credit-types";
import { signInAs, type SignedInSession } from "../../support/test-users";

/** feature/credit-types checklist R (permissions), A4/A5/U12 (API half) and cross-tenant isolation. */
describe("credit types — permissions and tenant isolation (checklist R1–R3, U12)", () => {
  let owner: SignedInSession;
  let staff: SignedInSession;
  let coach: SignedInSession;
  let client: SignedInSession;
  let seedTypeId: string;
  const toRetire: string[] = [];

  beforeAll(async () => {
    [owner, staff, coach, client] = await Promise.all([
      signInAs("owner"),
      signInAs("staff"),
      signInAs("coach"),
      signInAs("client"),
    ]);
    seedTypeId = (await listCreditTypes(owner.client)).types.find((t) => t.code === "SGPT")!.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of toRetire) await retireCreditType(owner.client, id);
  });

  const body = () => ({ code: `ZZ${Date.now() % 1e9}`.slice(0, 12), name: "n", fullName: "f", color: "teal" });

  it("R1 — a coach cannot create, edit, deactivate, reactivate or preview-deactivate credit types (403)", async () => {
    for (const [method, path, payload] of [
      ["post", "/credit-types", body()],
      ["post", "/credit-types/update", { id: seedTypeId, name: "hijack" }],
      ["post", "/credit-types/deactivate", { id: seedTypeId, lotAction: "FREEZE" }],
      ["post", "/credit-types/reactivate", { id: seedTypeId }],
    ] as const) {
      const res = await coach.client[method](path, payload);
      expect(res.status, `${path} as coach`).toBe(403);
    }
    expect((await coach.client.get(`/credit-types/deactivation-impact?id=${seedTypeId}`)).status).toBe(403);
  });

  it("R1 — a client cannot create, edit, deactivate or reactivate credit types", async () => {
    for (const [path, payload] of [
      ["/credit-types", body()],
      ["/credit-types/update", { id: seedTypeId, name: "hijack" }],
      ["/credit-types/deactivate", { id: seedTypeId, lotAction: "FREEZE" }],
      ["/credit-types/reactivate", { id: seedTypeId }],
    ] as const) {
      const res = await client.client.post(path, payload);
      expect([401, 403], `${path} as client`).toContain(res.status);
    }
  });

  it("R1/D10 — coach and client can read the ACTIVE list (200), but not includeInactive (403)", async () => {
    for (const who of [coach, client]) {
      const active = await listCreditTypes(who.client);
      expect(active.status).toBe(200);
      expect(active.types.map((t) => t.code)).toEqual(expect.arrayContaining(["SGPT", "PT"]));
      expect(active.types.every((t) => t.active)).toBe(true);
      expect((await listCreditTypes(who.client, true)).status).toBe(403);
    }
  });

  it("no session — every credit-types endpoint is 401", async () => {
    const anon = newClient();
    expect((await anon.get("/credit-types")).status).toBe(401);
    expect((await anon.post("/credit-types", body())).status).toBe(401);
    expect((await anon.post("/credit-types/deactivate", { id: seedTypeId, lotAction: "FREEZE" })).status).toBe(401);
  });

  it("A4/U12 — the staff (admin role) account may manage credit types over the API; the UI gate is separate", async () => {
    const t = await createCreditType(staff.client);
    toRetire.push(t.id);
    expect(t.active).toBe(true);
  });

  it("R3 — another organization's admin cannot see, edit, deactivate or reactivate this org's credit types", async () => {
    const { session: attacker } = await createUnrelatedOrgAdmin("staff", "owner");

    const list = await listCreditTypes(attacker.client, true);
    expect(list.status).toBe(200);
    expect(list.types.find((t) => t.id === seedTypeId)).toBeUndefined();
    expect(list.types.find((t) => t.code === "SGPT")).toBeUndefined();

    const update = await attacker.client.post("/credit-types/update", { id: seedTypeId, name: "pwned" });
    expect(update.status).toBe(404);
    const deactivate = await attacker.client.post("/credit-types/deactivate", {
      id: seedTypeId,
      lotAction: "FREEZE",
    });
    expect(deactivate.status).toBe(404);
    expect((await attacker.client.post("/credit-types/reactivate", { id: seedTypeId })).status).toBe(404);
    expect((await attacker.client.get(`/credit-types/deactivation-impact?id=${seedTypeId}`)).status).toBe(404);

    // …and the victim org's type is untouched.
    const still = (await listCreditTypes(owner.client)).types.find((t) => t.id === seedTypeId)!;
    expect(still.active).toBe(true);
    expect(still.name).not.toBe("pwned");
  }, 90_000);

  it("B8 — the same code can exist in another organization", async () => {
    const { session: otherOwner } = await createUnrelatedOrgAdmin("coach", "owner");
    const mine = await createCreditType(owner.client);
    toRetire.push(mine.id);
    const theirs = await createCreditType(otherOwner.client, { code: mine.code });
    expect(theirs.code).toBe(mine.code);
    expect(theirs.id).not.toBe(mine.id);
    await retireCreditType(otherOwner.client, theirs.id);
  }, 90_000);
});
