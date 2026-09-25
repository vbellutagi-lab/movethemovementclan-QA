import { beforeAll, describe, expect, it } from "vitest";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * docs/scenarios.md §3.2–3.4 — these were previously "reasoned safe from code reading" only
 * (Drizzle is fully parameterized, every input schema reviewed is a strict zod allow-list with
 * no .passthrough()/z.any()). This file exercises live payloads against the running instance so
 * a future schema/query change that reintroduces a gap gets caught by CI, not by code review.
 */
describe("input validation — injection & mass assignment (docs/scenarios.md §3.2–3.4)", () => {
  let owner: SignedInSession;
  let clientId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    const client = await signInAs("client");
    clientId = (await getClientProfile(client.client)).id;
  }, 30_000);

  it("§3.2 — a SQL-injection-shaped reason string is stored/rejected inertly, never causes a 500", async () => {
    const payload = "'; DROP TABLE credit_lots; --";
    const res = await owner.client.post<{ data: { lotId: string; remaining: number } }>(
      "/credits/grant",
      {
        clientId,
        creditType: "SGPT",
        amount: 1,
        expiresAt: null,
        centreScope: null,
        reason: payload,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.remaining).toBe(1);

    // Confirm the table (and this client's balance) genuinely still exists and is queryable.
    const balances = await owner.client.get(`/credits/balances?clientId=${clientId}`);
    expect(balances.status).toBe(200);

    await owner.client.post("/credits/reverse", {
      lotId: res.body!.data.lotId,
      clientId,
      amount: 1,
      reason: "cleanup",
    });
  });

  it("§3.3 — an XSS payload in a free-text field is stored and returned verbatim (API doesn't own output encoding), not stripped or 500'd", async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const grant = await owner.client.post<{ data: { lotId: string } }>("/credits/grant", {
      clientId,
      creditType: "SGPT",
      amount: 1,
      expiresAt: null,
      centreScope: null,
      reason: payload,
    });
    expect(grant.status).toBe(200);

    await owner.client.post("/credits/reverse", {
      lotId: grant.body!.data.lotId,
      clientId,
      amount: 1,
      reason: payload,
    });
  });

  it("§3.4 — credits.grant silently drops unknown/dangerous fields (id, balanceAfter, remaining, organizationId) instead of trusting them", async () => {
    const smuggled = {
      clientId,
      creditType: "SGPT",
      amount: 1,
      expiresAt: null,
      centreScope: null,
      reason: "QA mass-assignment probe",
      // None of these are part of the real input schema — a zod allow-list should ignore them.
      id: "00000000-0000-4000-8000-000000000000",
      balanceAfter: 999999,
      remaining: 999999,
      organizationId: "00000000-0000-4000-8000-000000000001",
      lotId: "00000000-0000-4000-8000-000000000002",
    };
    const res = await owner.client.post<{ data: { lotId: string; remaining: number } }>(
      "/credits/grant",
      smuggled,
    );
    expect(res.status).toBe(200);
    // Real balance is the actual granted amount, not the smuggled 999999.
    expect(res.body?.data?.remaining).toBe(1);
    expect(res.body?.data?.lotId).not.toBe(smuggled.lotId);

    await owner.client.post("/credits/reverse", {
      lotId: res.body!.data.lotId,
      clientId,
      amount: 1,
      reason: "cleanup",
    });
  });

  it("§3.4 — clients.enroll silently drops an attempt to smuggle role/id/organizationId into the input", async () => {
    const email = `mass-assign-${Date.now()}@move-qa.test`;
    const centre = await owner.client.get<{ data: Array<{ id: string }> }>(
      "/organizations/move-dev/centres",
    );
    const centreId = centre.body!.data[0]!.id;
    const coach = await owner.client.get<{ data: Array<{ id: string }> }>("/coaches");

    const res = await owner.client.post<{ data: { id: string; homeCentreId: string } }>(
      "/clients/enroll",
      {
        email,
        name: "Mass Assignment Probe",
        homeCentreId: centreId,
        coachId: coach.body?.data?.[0]?.id,
        // Not part of the real enroll input schema.
        id: "00000000-0000-4000-8000-000000000003",
        role: "superadmin",
        organizationId: "00000000-0000-4000-8000-000000000004",
        status: "banned",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body?.data?.id).not.toBe("00000000-0000-4000-8000-000000000003");
    expect(res.body?.data?.homeCentreId).toBe(centreId);
  });
});
