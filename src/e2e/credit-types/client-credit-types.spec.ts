import { expect, test } from "@playwright/test";
import { signInBrowserAs, signInBrowserWithClient } from "../../support/browser-session";
import { createVerifiedEnrolledClient } from "../../support/fixtures";
import { createCreditType, retireCreditType } from "../../support/credit-types";
import { getClientProfile, signInAs } from "../../support/test-users";

/** feature/credit-types checklist D10 and M (what a client sees, incl. frozen credits). */
test.describe("client portal — credit types and frozen credits (checklist D10, M)", () => {
  test("D10 — a client's /client/sessions loads credit types with a 200 (not 400) and shows every active type as a filter", async ({
    page,
    context,
  }) => {
    const owner = await signInAs("owner");
    const created = await createCreditType(owner.client, { name: "ClientVis", fullName: "Client visible type" });

    const statuses: number[] = [];
    page.on("response", (res) => {
      if (res.url().includes("creditTypes.list")) statuses.push(res.status());
    });

    await signInBrowserAs(context, "client");
    await page.goto("/client/sessions");
    await expect(page).toHaveURL(/\/client\/sessions$/);
    await expect(page.getByText("Not authorized")).toHaveCount(0);
    await expect.poll(() => statuses.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 200), `creditTypes.list statuses: ${statuses}`).toBe(true);
    // a type created moments ago is already offered as a filter chip (labelled by short name or code)
    await expect(page.getByText(new RegExp(`^(ClientVis|${created.code})$`)).first()).toBeVisible({
      timeout: 15_000,
    });

    await retireCreditType(owner.client, created.id);
  });

  test("M7/M9/M11 — frozen credits: the client sees them as frozen (dashboard, packages), not as spendable; reactivating restores them", async ({
    page,
    context,
  }) => {
    const owner = await signInAs("owner");
    const fresh = await createVerifiedEnrolledClient("ct-frozen");
    const clientId = (await getClientProfile(fresh.client)).id;
    const type = await createCreditType(owner.client, { name: "Frz", fullName: "Frozen QA type", color: "cond" });

    const grant = await owner.client.post("/credits/grant", {
      clientId,
      creditType: type.code,
      amount: 4,
      expiresAt: null,
      centreScope: null,
      reason: "QA frozen visibility",
    });
    expect(grant.status).toBe(200);

    await signInBrowserWithClient(context, fresh.client);

    // spendable before freezing
    await page.goto("/client");
    await expect(page.getByText(/\d+ frozen/i)).toHaveCount(0);

    const freeze = await owner.client.post("/credit-types/deactivate", { id: type.id, lotAction: "FREEZE" });
    expect(freeze.status).toBe(200);

    await page.goto("/client");
    await expect(page.getByText(/4 frozen/i).first()).toBeVisible({ timeout: 15_000 });

    await page.goto("/client/packages");
    await expect(page.getByText("Frozen", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^credits frozen$/)).toBeVisible();
    await expect(page.getByText(/^Frozen on /)).toBeVisible();

    const react = await owner.client.post("/credit-types/reactivate", { id: type.id });
    expect(react.status).toBe(200);
    await page.goto("/client/packages");
    await expect(page.getByText(/^credits frozen$/)).toHaveCount(0, { timeout: 15_000 });

    // tidy: drain the lot so the throwaway client holds nothing, then retire the type
    const lots = await owner.client.get<{ data: { lots: { id: string; remaining: number }[] } }>(
      `/credits/lots-for-client?clientId=${clientId}`,
    );
    for (const lot of lots.body.data.lots.filter((l) => l.remaining > 0)) {
      await owner.client.post("/credits/reverse", {
        lotId: lot.id,
        clientId,
        amount: lot.remaining,
        reason: "QA cleanup",
      });
    }
    await retireCreditType(owner.client, type.id);
  });
});
