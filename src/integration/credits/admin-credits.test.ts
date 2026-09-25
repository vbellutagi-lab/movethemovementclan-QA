import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { nonExistentUuid } from "../../support/random";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

describe("credits — admin operations (docs/scenarios.md §7.11–7.13)", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let clientId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    const client = await signInAs("client");
    clientId = (await getClientProfile(client.client)).id;
  }, 30_000);

  it("grants credit as admin — happy path", async () => {
    const res = await owner.client.post<{ data: { lotId: string; remaining: number } }>(
      "/credits/grant",
      {
        clientId,
        creditType: "SGPT",
        amount: 5,
        expiresAt: null,
        centreScope: null,
        reason: "QA admin-credits happy path",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.remaining).toBe(5);
  });

  it("grants credit as a non-admin org member (coach) — forbidden", async () => {
    const res = await coach.client.post("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount: 5,
      expiresAt: null,
      centreScope: null,
      reason: "should be forbidden",
    });
    expect(res.status).toBe(403);
  });

  it("grants credit with no session at all — 401", async () => {
    const anon = newClient();
    const res = await anon.post("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount: 5,
      expiresAt: null,
      centreScope: null,
      reason: "n/a",
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-positive / zero amounts before touching the ledger", async () => {
    const zero = await owner.client.post("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount: 0,
      expiresAt: null,
      centreScope: null,
      reason: "n/a",
    });
    expect(zero.status).toBe(400);

    const negative = await owner.client.post("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount: -5,
      expiresAt: null,
      centreScope: null,
      reason: "n/a",
    });
    expect(negative.status).toBe(400);
  });

  it("reversing more than the lot's balance is rejected and leaves the balance untouched", async () => {
    const grant = await owner.client.post<{ data: { lotId: string; remaining: number } }>(
      "/credits/grant",
      {
        clientId,
        creditType: "SGPT",
        amount: 2,
        expiresAt: null,
        centreScope: null,
        reason: "QA over-reversal fixture",
      },
    );
    const lotId = grant.body!.data.lotId;

    const overReverse = await owner.client.post("/credits/reverse", {
      lotId,
      clientId,
      amount: 999,
      reason: "should fail — exceeds balance",
    });
    // FINDING: packages/services/credits/error.ts declares InsufficientCreditsError as
    // ServiceError(422, ...) and documents/architecture/booking.md's error table says 422 — but
    // packages/trpc/server/utils/http-status.ts's HTTP_STATUS_TO_TRPC_CODE maps 422 to the tRPC
    // code "BAD_REQUEST" (tRPC has no native 422 code), which the OpenAPI adapter serializes back
    // out as HTTP 400. So "insufficient credits" is indistinguishable from a generic validation
    // error by status code alone over the wire — only the response body's `message` differs.
    expect(overReverse.status).toBe(400);

    const validReverse = await owner.client.post<{ data: { balanceAfter: number } }>(
      "/credits/reverse",
      { lotId, clientId, amount: 2, reason: "clean up QA fixture" },
    );
    expect(validReverse.status).toBe(200);
    expect(validReverse.body?.data?.balanceAfter).toBe(0);
  });

  it("extends a lot's expiry", async () => {
    const grant = await owner.client.post<{ data: { lotId: string } }>("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount: 1,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      centreScope: null,
      reason: "QA extend-expiry fixture",
    });
    const lotId = grant.body!.data.lotId;
    const newExpiry = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

    const res = await owner.client.post<{ data: { lotId: string; expiresAt: string | null } }>(
      "/credits/extend-expiry",
      { lotId, newExpiresAt: newExpiry, reason: "QA extend-expiry fixture" },
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.expiresAt).toBe(newExpiry);

    await owner.client.post("/credits/reverse", { lotId, clientId, amount: 1, reason: "cleanup" });
  });

  it("reversing a non-existent lot returns 404 — the round-3 org-ownership guard (docs/scenarios.md §1.11) now runs before the amount-guard and 404s on a lot it can't find, matching the existence-hiding convention used everywhere else (previously 400, see round-3 note in docs/scenarios.md)", async () => {
    const res = await owner.client.post("/credits/reverse", {
      lotId: nonExistentUuid(),
      clientId,
      amount: 1,
      reason: "n/a",
    });
    expect(res.status).toBe(404);
  });
});
