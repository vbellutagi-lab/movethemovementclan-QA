import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerifiedEnrolledClient } from "../../support/fixtures";
import {
  balanceFor,
  createCreditType,
  listCreditTypes,
  retireCreditType,
  uniqueCreditTypeCode,
  type CreditTypeDto,
} from "../../support/credit-types";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

interface Impact {
  clientsHolding: number;
  lotsHeld: number;
  creditsHeld: number;
  sessionTypes: { id: string; name: string }[];
  packages: { id: string; name: string }[];
  pendingCreditRequests: number;
  canDeactivate: boolean;
}

/**
 * feature/credit-types checklist D, E, I, J, K, L — deactivate (freeze / move), reactivate, and
 * what an inactive type does to grants, session types and packages. Every test builds its own
 * throwaway credit types + a freshly enrolled client, so it does not depend on (or disturb) the
 * seeded balances. Credit types cannot be deleted, so they are retired (deactivated) afterwards.
 */
describe("credit types — deactivate / reactivate lifecycle (checklist D–L)", () => {
  let owner: SignedInSession;
  let clientId: string;
  const types: CreditTypeDto[] = [];
  const sessionTypeIds: string[] = [];
  const packageIds: string[] = [];

  const mk = async (overrides: Parameters<typeof createCreditType>[1] = {}) => {
    const t = await createCreditType(owner.client, overrides);
    types.push(t);
    return t;
  };
  const grant = (code: string, amount: number, extra: Record<string, unknown> = {}) =>
    owner.client.post<{ data: { lotId: string; remaining: number } }>("/credits/grant", {
      clientId,
      creditType: code,
      amount,
      expiresAt: null,
      centreScope: null,
      reason: "QA credit-types lifecycle",
      ...extra,
    });
  const impact = async (id: string) =>
    (await owner.client.get<{ data: Impact }>(`/credit-types/deactivation-impact?id=${id}`)).body.data;

  beforeAll(async () => {
    owner = await signInAs("owner");
    const fresh = await createVerifiedEnrolledClient("ct-lifecycle");
    clientId = (await getClientProfile(fresh.client)).id;
  }, 60_000);

  afterAll(async () => {
    // Retire session types first (an active one blocks deactivation), then packages, then types.
    for (const id of sessionTypeIds) await owner.client.post("/session-types/update", { id, active: false });
    for (const id of packageIds) await owner.client.post("/packages/update", { id, active: false });
    for (const t of types) await retireCreditType(owner.client, t.id);
  });

  it("I4/E1 — a fresh type with no holders previews 0 / 0 / 0 and can be deactivated; grants show on the balance", async () => {
    const t = await mk();
    const g = await grant(t.code, 5);
    expect(g.status).toBe(200);
    expect(await balanceFor(owner.client, clientId, t.code)).toMatchObject({ balance: 5, frozen: 0 });

    const empty = await mk();
    expect(await impact(empty.id)).toMatchObject({
      clientsHolding: 0,
      lotsHeld: 0,
      creditsHeld: 0,
      canDeactivate: true,
    });
  });

  it("J2/J3 — the impact preview counts clients, lots and credits exactly", async () => {
    const t = await mk();
    await grant(t.code, 4);
    await grant(t.code, 2);
    expect(await impact(t.id)).toMatchObject({ clientsHolding: 1, lotsHeld: 2, creditsHeld: 6, canDeactivate: true });
  });

  it("J5/J6/M3 — FREEZE keeps the balance but makes it unspendable (frozen), and hides the type from the active list", async () => {
    const t = await mk();
    await grant(t.code, 4);

    const res = await owner.client.post<{ data: CreditTypeDto }>("/credit-types/deactivate", {
      id: t.id,
      lotAction: "FREEZE",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);

    expect(await balanceFor(owner.client, clientId, t.code)).toMatchObject({ balance: 0, frozen: 4 });
    const active = await listCreditTypes(owner.client);
    expect(active.types.find((x) => x.id === t.id)).toBeUndefined();
    const all = await listCreditTypes(owner.client, true);
    expect(all.types.find((x) => x.id === t.id)?.active).toBe(false);
  });

  it("L1/L2/L5 — reactivating unfreezes the credits; the type returns to the active list", async () => {
    const t = await mk();
    await grant(t.code, 3);
    await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" });
    expect(await balanceFor(owner.client, clientId, t.code)).toMatchObject({ balance: 0, frozen: 3 });

    const res = await owner.client.post<{ data: CreditTypeDto }>("/credit-types/reactivate", { id: t.id });
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect(await balanceFor(owner.client, clientId, t.code)).toMatchObject({ balance: 3, frozen: 0 });
    expect((await listCreditTypes(owner.client)).types.find((x) => x.id === t.id)).toBeTruthy();
  });

  it("K1–K3/K6 — TRANSFER moves lots to the target type (nothing frozen); reactivating the old type does not move them back", async () => {
    const from = await mk();
    const to = await mk();
    await grant(from.code, 5);

    const res = await owner.client.post("/credit-types/deactivate", {
      id: from.id,
      lotAction: "TRANSFER",
      targetCreditTypeId: to.id,
    });
    expect(res.status).toBe(200);
    expect(await balanceFor(owner.client, clientId, to.code)).toMatchObject({ balance: 5, frozen: 0 });
    expect(await balanceFor(owner.client, clientId, from.code)).toMatchObject({ balance: 0, frozen: 0 });

    await owner.client.post("/credit-types/reactivate", { id: from.id });
    expect(await balanceFor(owner.client, clientId, to.code)).toMatchObject({ balance: 5 });
    expect(await balanceFor(owner.client, clientId, from.code)).toMatchObject({ balance: 0 });
  });

  it("I7/J12 — TRANSFER needs a target, and the target can't be the type itself or an inactive type", async () => {
    const a = await mk();
    const inactive = await mk();
    await owner.client.post("/credit-types/deactivate", { id: inactive.id, lotAction: "FREEZE" });

    const noTarget = await owner.client.post("/credit-types/deactivate", { id: a.id, lotAction: "TRANSFER" });
    expect(noTarget.status).toBeGreaterThanOrEqual(400);
    const toSelf = await owner.client.post("/credit-types/deactivate", {
      id: a.id,
      lotAction: "TRANSFER",
      targetCreditTypeId: a.id,
    });
    expect(toSelf.status).toBeGreaterThanOrEqual(400);
    const toInactive = await owner.client.post("/credit-types/deactivate", {
      id: a.id,
      lotAction: "TRANSFER",
      targetCreditTypeId: inactive.id,
    });
    expect(toInactive.status).toBeGreaterThanOrEqual(400);
    expect((await listCreditTypes(owner.client)).types.find((x) => x.id === a.id)?.active).toBe(true);
  });

  it("I9 — a type used by an ACTIVE session type cannot be deactivated (409, canDeactivate=false); once the session type is inactive it can (O7)", async () => {
    const t = await mk();
    const st = await owner.client.post<{ data: { id: string } }>("/session-types", {
      code: uniqueCreditTypeCode("ST"),
      name: "QA session type",
      durationMin: 30,
      creditType: t.code,
      creditCost: 1,
    });
    expect(st.status).toBe(200);
    sessionTypeIds.push(st.body.data.id);

    const preview = await impact(t.id);
    expect(preview.canDeactivate).toBe(false);
    expect(preview.sessionTypes.map((s) => s.id)).toContain(st.body.data.id);

    const blocked = await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" });
    expect(blocked.status).toBe(409);
    expect((await listCreditTypes(owner.client)).types.find((x) => x.id === t.id)?.active).toBe(true);

    const off = await owner.client.post("/session-types/update", { id: st.body.data.id, active: false });
    expect(off.status).toBe(200);
    const ok = await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" });
    expect(ok.status).toBe(200);
  });

  it("I10 — deactivating twice (two tabs): the second attempt errors, state stays inactive", async () => {
    const t = await mk();
    expect((await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" })).status).toBe(200);
    const second = await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
  });

  it("E5/J10d/D — granting, creating a session type, or creating a package on an INACTIVE type is refused; no lot is created", async () => {
    const t = await mk();
    await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" });

    const g = await grant(t.code, 2);
    expect(g.status).toBeGreaterThanOrEqual(400);
    expect(g.status).toBeLessThan(500);
    expect(await balanceFor(owner.client, clientId, t.code)).toMatchObject({ balance: 0, frozen: 0 });

    const st = await owner.client.post("/session-types", {
      code: uniqueCreditTypeCode("ST"),
      name: "should fail",
      durationMin: 30,
      creditType: t.code,
      creditCost: 1,
    });
    expect(st.status).toBeGreaterThanOrEqual(400);
    expect(st.status).toBeLessThan(500);

    const pkg = await owner.client.post("/packages", {
      name: `QA inactive ${t.code}`,
      packageType: "CREDIT_BASED",
      pricePaise: 1000,
      creditGrants: { [t.code]: 3 },
      durationPreset: "THIRTY_DAYS",
      validityDays: 30,
      centreScope: null,
    });
    expect(pkg.status).toBeGreaterThanOrEqual(400);
    expect(pkg.status).toBeLessThan(500);
  });

  it("D/E — an unknown credit type code is rejected on grant", async () => {
    const res = await grant("NOPE_NOT_A_TYPE", 1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("H5a–H5d/J7 — package grants: REPLACE_GRANT rewrites them; KEEP locks the inactive grant; reactivating unlocks it", async () => {
    const keepType = await mk();
    const replaceType = await mk();
    const target = await mk();

    const mkPkg = async (grants: Record<string, number>) => {
      const res = await owner.client.post<{ data: { id: string; creditGrants: Record<string, number> } }>("/packages", {
        name: `QA pkg ${uniqueCreditTypeCode("P")}`,
        packageType: "CREDIT_BASED",
        pricePaise: 1000,
        creditGrants: grants,
        durationPreset: "THIRTY_DAYS",
        validityDays: 30,
        centreScope: null,
      });
      expect(res.status).toBe(200);
      packageIds.push(res.body.data.id);
      return res.body.data.id;
    };
    const readPkg = async (id: string) =>
      (await owner.client.get<{ data: { id: string; creditGrants: Record<string, number> | null }[] }>("/packages")).body.data.find(
        (p) => p.id === id,
      )!;

    // REPLACE_GRANT: {replaceType:3, target:2} → {target: 5} (amounts add when the target is already granted)
    const replacePkg = await mkPkg({ [replaceType.code]: 3, [target.code]: 2 });
    expect(preview(await impact(replaceType.id)).packages).toContain(replacePkg);
    const rep = await owner.client.post("/credit-types/deactivate", {
      id: replaceType.id,
      lotAction: "FREEZE",
      packageAction: "REPLACE_GRANT",
      packageTargetCreditTypeId: target.id,
    });
    expect(rep.status).toBe(200);
    expect((await readPkg(replacePkg)).creditGrants).toEqual({ [target.code]: 5 });

    // KEEP: grant stays, but is locked while the type is inactive.
    const keepPkg = await mkPkg({ [keepType.code]: 4, [target.code]: 1 });
    const kept = await owner.client.post("/credit-types/deactivate", {
      id: keepType.id,
      lotAction: "FREEZE",
      packageAction: "KEEP",
    });
    expect(kept.status).toBe(200);
    expect((await readPkg(keepPkg)).creditGrants).toEqual({ [keepType.code]: 4, [target.code]: 1 });

    // H5b: changing only name/price, or an active type's amount, with the locked grant unchanged → ok
    const renamed = await owner.client.post("/packages/update", {
      id: keepPkg,
      name: "QA renamed",
      pricePaise: 2000,
      creditGrants: { [keepType.code]: 4, [target.code]: 9 },
    });
    expect(renamed.status).toBe(200);

    // H5c: raising, lowering, removing the locked grant or adding another inactive type → refused
    for (const grants of [
      { [keepType.code]: 5, [target.code]: 9 },
      { [keepType.code]: 1, [target.code]: 9 },
      { [target.code]: 9 },
      { [keepType.code]: 4, [replaceType.code]: 1, [target.code]: 9 },
    ]) {
      const res = await owner.client.post("/packages/update", { id: keepPkg, creditGrants: grants });
      expect(res.status, JSON.stringify(grants)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.rawText).toMatch(/not an active credit type|locked/i);
    }
    expect((await readPkg(keepPkg)).creditGrants).toEqual({ [keepType.code]: 4, [target.code]: 9 });

    // H5d: reactivate → editable again
    await owner.client.post("/credit-types/reactivate", { id: keepType.id });
    const unlocked = await owner.client.post("/packages/update", {
      id: keepPkg,
      creditGrants: { [keepType.code]: 6, [target.code]: 9 },
    });
    expect(unlocked.status).toBe(200);
  });

  it("F4/F5/J10d — a pending coach request for a type that is then deactivated shows in the impact count and can't be approved", async () => {
    const coach = await signInAs("coach");
    const coachClient = await signInAs("client"); // coach 1's seeded client — coaches may only request for their own
    const ownClientId = (await getClientProfile(coachClient.client)).id;
    const t = await mk();

    const req = await coach.client.post<{ data: { requestId: string } }>("/credit-requests/create", {
      clientId: ownClientId,
      creditType: t.code,
      amount: 3,
      expiresAt: null,
      centreScope: null,
      reason: "QA request then deactivate",
    });
    expect(req.status).toBe(200);
    expect((await impact(t.id)).pendingCreditRequests).toBe(1);

    expect((await owner.client.post("/credit-types/deactivate", { id: t.id, lotAction: "FREEZE" })).status).toBe(200);
    const approve = await owner.client.post("/credit-requests/approve", { requestId: req.body.data.requestId });
    expect(approve.status).toBeGreaterThanOrEqual(400);
    expect(approve.status).toBeLessThan(500);
    expect(await balanceFor(owner.client, ownClientId, t.code)).toMatchObject({ balance: 0, frozen: 0 });

    // clean up the dangling request so it doesn't linger on the owner's pending list
    const cleanup = await owner.client.post("/credit-requests/reject", { requestId: req.body.data.requestId, reviewNote: "QA cleanup" });
    expect(cleanup.status, cleanup.rawText).toBe(200);
  });

  it("F2 FINDING — the UI hides other coaches' clients, but the API does NOT enforce it: coach 1 can file a credit request for coach 2's client (client3@move.dev)", async () => {
    // Checklist F2 ("Coach 1 cannot request for C3") only holds in the UI. creditRequests.create
    // (packages/trpc/server/routes/credit-requests/route.ts) passes clientId straight to the
    // service with no coach-ownership check. This asserts the CURRENT behavior, like the other
    // FINDING specs in this suite; flip it to expect 403/404 when the server enforces scoping.
    const coach = await signInAs("coach");
    const c3 = await signInAs("client3");
    const c3Id = (await getClientProfile(c3.client)).id;
    const t = await mk();
    const res = await coach.client.post<{ data: { requestId: string } }>("/credit-requests/create", {
      clientId: c3Id,
      creditType: t.code,
      amount: 1,
      expiresAt: null,
      centreScope: null,
      reason: "QA F2 — cross-coach request",
    });
    expect(res.status).toBe(200);
    // never grant anything, never leave it on the owner's pending list
    const cleanup = await owner.client.post("/credit-requests/reject", { requestId: res.body.data.requestId, reviewNote: "QA cleanup" });
    expect(cleanup.status, cleanup.rawText).toBe(200);
    expect(await balanceFor(owner.client, c3Id, t.code)).toMatchObject({ balance: 0, frozen: 0 });
  });
});

function preview(i: Impact) {
  return { packages: i.packages.map((p) => p.id) };
}
