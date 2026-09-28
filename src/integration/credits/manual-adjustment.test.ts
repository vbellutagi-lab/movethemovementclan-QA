import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { nonExistentUuid } from "../../support/random";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * New in v1.1.0->develop: credits.setStartDate / credits.listLotsForClient — the owner-facing
 * "Adjust credits" dialog for manually correcting a lot's start date (and, via
 * expiresAtOverride, its expiry). Not covered by admin-credits.test.ts, which predates this
 * endpoint pair.
 */
describe("credits — manual lot adjustment (setStartDate / listLotsForClient)", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let clientId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    const client = await signInAs("client");
    clientId = (await getClientProfile(client.client)).id;
  }, 30_000);

  async function grantFixtureLot(amount = 1): Promise<string> {
    const grant = await owner.client.post<{ data: { lotId: string } }>("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      centreScope: null,
      reason: "QA manual-adjustment fixture",
    });
    expect(grant.status).toBe(200);
    return grant.body!.data.lotId;
  }

  it("sets a lot's start date and an explicit (verbatim) expiry override", async () => {
    const lotId = await grantFixtureLot();
    const startDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const explicitExpiry = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

    try {
      const res = await owner.client.post<{
        data: { lotId: string; startDate: string; expiresAt: string | null };
      }>("/credits/set-start-date", {
        lotId,
        startDate,
        expiresAtOverride: explicitExpiry,
        reason: "QA — verbatim override",
      });
      expect(res.status).toBe(200);
      expect(res.body?.data?.startDate).toBe(startDate);
      expect(res.body?.data?.expiresAt).toBe(explicitExpiry);

      const list = await owner.client.get<{
        data: { lots: Array<{ id: string; startDate: string | null; expiresAt: string | null }> };
      }>(`/credits/lots-for-client?clientId=${clientId}`);
      expect(list.status).toBe(200);
      const lot = list.body?.data?.lots.find((l) => l.id === lotId);
      expect(lot?.startDate).toBe(startDate);
      expect(lot?.expiresAt).toBe(explicitExpiry);
    } finally {
      await owner.client.post("/credits/reverse", { lotId, clientId, amount: 1, reason: "cleanup" });
    }
  });

  it("clears a lot's expiry with expiresAtOverride: null", async () => {
    const lotId = await grantFixtureLot();
    try {
      const res = await owner.client.post<{ data: { expiresAt: string | null } }>(
        "/credits/set-start-date",
        {
          lotId,
          startDate: new Date().toISOString(),
          expiresAtOverride: null,
          reason: "QA — clear expiry",
        },
      );
      expect(res.status).toBe(200);
      expect(res.body?.data?.expiresAt).toBeNull();
    } finally {
      await owner.client.post("/credits/reverse", { lotId, clientId, amount: 1, reason: "cleanup" });
    }
  });

  it("setStartDate as a non-admin org member (coach) is forbidden", async () => {
    const lotId = await grantFixtureLot();
    try {
      const res = await coach.client.post("/credits/set-start-date", {
        lotId,
        startDate: new Date().toISOString(),
        reason: "should be forbidden",
      });
      expect(res.status).toBe(403);
    } finally {
      await owner.client.post("/credits/reverse", { lotId, clientId, amount: 1, reason: "cleanup" });
    }
  });

  it("listLotsForClient as a non-admin org member (coach) is forbidden", async () => {
    const res = await coach.client.get(`/credits/lots-for-client?clientId=${clientId}`);
    expect(res.status).toBe(403);
  });

  it("setStartDate / listLotsForClient with no session at all — 401", async () => {
    const anon = newClient();
    const res1 = await anon.post("/credits/set-start-date", {
      lotId: nonExistentUuid(),
      startDate: new Date().toISOString(),
      reason: "n/a",
    });
    expect(res1.status).toBe(401);

    const res2 = await anon.get(`/credits/lots-for-client?clientId=${clientId}`);
    expect(res2.status).toBe(401);
  });

  it("setStartDate on a non-existent lot returns 404 (existence-hiding, matches reverse/extend-expiry)", async () => {
    const res = await owner.client.post("/credits/set-start-date", {
      lotId: nonExistentUuid(),
      startDate: new Date().toISOString(),
      reason: "n/a",
    });
    expect(res.status).toBe(404);
  });
});
