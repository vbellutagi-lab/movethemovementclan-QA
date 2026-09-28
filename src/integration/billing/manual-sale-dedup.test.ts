import { beforeAll, describe, expect, it } from "vitest";
import { createVerifiedEnrolledClient } from "../../support/fixtures";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * Regression test for 3ba7b2b (fix(billing): stop manual sales from duplicating a pending
 * purchase request). Before the fix: a client requests a renewal (billing.requestRenewal), then
 * staff separately records the same real-world purchase via billing.createManualSale — this used
 * to insert an UNLINKED second payment/credit-grant instead of fulfilling the existing request,
 * silently double-crediting the client. createManualSale now looks up an active REQUESTED
 * purchase request for the same client+package and fulfills it in place of inserting a new one.
 */
describe("billing — createManualSale fulfills a matching pending purchase request instead of duplicating it", () => {
  let owner: SignedInSession;
  let packageId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    const packages = await owner.client.get<{
      data: Array<{ id: string; active: boolean }>;
    }>("/packages");
    expect(packages.status).toBe(200);
    const active = packages.body?.data?.find((p) => p.active);
    if (!active) throw new Error("No active package found — is the target instance seeded?");
    packageId = active.id;
  }, 30_000);

  it("a manual sale for a client with an existing matching request fulfills it, not a duplicate", async () => {
    const fresh = await createVerifiedEnrolledClient("manual-sale-dedup");
    const clientId = (await getClientProfile(fresh.client)).id;

    const renewal = await fresh.client.post<{ data: { purchaseRequestId: string } }>(
      "/billing/request-renewal",
      { packageId },
    );
    expect(renewal.status).toBe(200);
    const purchaseRequestId = renewal.body!.data.purchaseRequestId;

    const pendingBefore = await owner.client.get<{
      data: Array<{ id: string; clientId: string; packageId: string }>;
    }>("/billing/pending-purchase-requests");
    expect(
      pendingBefore.body?.data?.some((r) => r.id === purchaseRequestId && r.clientId === clientId),
    ).toBe(true);

    const sale = await owner.client.post<{ data: { paymentId: string } }>("/billing/manual-sale", {
      clientId,
      packageId,
      method: "CASH",
      externalReference: null,
      paymentDate: new Date().toISOString(),
    });
    expect(sale.status).toBe(200);

    // The request that manual-sale just fulfilled must no longer be pending — this is the
    // observable "didn't insert an unlinked second payment" signal: fulfilling clears it,
    // whereas the old unlinked-duplicate bug left it dangling as still-pending.
    const pendingAfter = await owner.client.get<{
      data: Array<{ id: string; clientId: string }>;
    }>("/billing/pending-purchase-requests");
    expect(pendingAfter.body?.data?.some((r) => r.id === purchaseRequestId)).toBe(false);

    // Exactly one credit lot for this client — not two (one from the phantom unlinked sale, one
    // from the request being separately fulfilled later).
    const lots = await owner.client.get<{ data: { lots: Array<{ id: string }> } }>(
      `/credits/lots-for-client?clientId=${clientId}`,
    );
    expect(lots.status).toBe(200);
    expect(lots.body?.data?.lots.length).toBe(1);
  });

  it("a manual sale for a client with NO pending request just records an ordinary new payment", async () => {
    const fresh = await createVerifiedEnrolledClient("manual-sale-no-request");
    const clientId = (await getClientProfile(fresh.client)).id;

    const sale = await owner.client.post<{ data: { paymentId: string } }>("/billing/manual-sale", {
      clientId,
      packageId,
      method: "CASH",
      externalReference: null,
      paymentDate: new Date().toISOString(),
    });
    expect(sale.status).toBe(200);

    const lots = await owner.client.get<{ data: { lots: Array<{ id: string }> } }>(
      `/credits/lots-for-client?clientId=${clientId}`,
    );
    expect(lots.body?.data?.lots.length).toBe(1);
  });
});
