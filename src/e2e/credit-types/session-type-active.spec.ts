import { expect, test, type Page } from "@playwright/test";
import { signInBrowserAs } from "../../support/browser-session";
import { uniqueCreditTypeCode } from "../../support/credit-types";
import { signInAs, type SignedInSession } from "../../support/test-users";

/** feature/credit-types checklist G (session types: Active flag UI). */
test.describe.serial("owner — session type Active flag (checklist G4–G9)", () => {
  let owner: SignedInSession;
  let sessionTypeId: string;
  let name: string;

  test.beforeAll(async () => {
    owner = await signInAs("owner");
    name = `QA Active ${uniqueCreditTypeCode("S")}`;
    const res = await owner.client.post<{ data: { id: string } }>("/session-types", {
      code: uniqueCreditTypeCode("SA"),
      name,
      durationMin: 30,
      creditType: "SGPT",
      creditCost: 1,
    });
    expect(res.status).toBe(200);
    sessionTypeId = res.body.data.id;
  });

  test.afterAll(async () => {
    // Session types can't be deleted; leave it inactive so it never shows up for clients.
    await owner.client.post("/session-types/update", { id: sessionTypeId, active: false });
  });

  /** The list is paginated and grows with every run, so page forward until the card shows. */
  async function findCard(page: Page) {
    await page.goto("/admin/session-types");
    const card = () =>
      page.locator("div", { hasText: name }).filter({ has: page.getByLabel("Edit session type") }).last();
    await expect(page.getByLabel("Edit session type").first()).toBeVisible({ timeout: 15_000 }); // list loaded
    for (let i = 0; i < 20; i++) {
      if (await card().count()) return card();
      const next = page.getByRole("button", { name: "Next", exact: true });
      if (!(await next.count()) || (await next.isDisabled())) break;
      const label = await page.getByText(/^Page \d+ of \d+$/).textContent();
      await next.click();
      await expect(page.getByText(/^Page \d+ of \d+$/)).not.toHaveText(label ?? "");
    }
    await expect(card()).toBeVisible({ timeout: 10_000 });
    return card();
  }

  const activeBox = (page: Page) => page.getByLabel(/Active - offered for scheduling and booking/);

  test("G4 — the create dialog has no Active checkbox; the edit dialog does, ticked", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    await page.goto("/admin/session-types");
    await page.getByRole("button", { name: "New session type" }).first().click();
    await expect(page.locator("#st-code")).toBeVisible();
    await expect(activeBox(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel" }).click();

    const card = await findCard(page);
    await card.getByLabel("Edit session type").click();
    await expect(activeBox(page)).toBeChecked();
  });

  test("G5/G7 — unticking Active dims the card with an Inactive badge; reopening shows it unticked", async ({
    page,
    context,
  }) => {
    await signInBrowserAs(context, "owner");
    let card = await findCard(page);
    await card.getByLabel("Edit session type").click();
    await activeBox(page).uncheck();
    await expect(page.getByText(/Clients won't see or book this session type's sessions/)).toBeVisible();
    await expect(page.getByText(/Existing bookings stay valid/)).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();

    card = await findCard(page);
    await expect(card.getByText("Inactive")).toBeVisible({ timeout: 15_000 });

    await card.getByLabel("Edit session type").click();
    await expect(activeBox(page)).not.toBeChecked();
  });

  test("G9 — editing another field of an inactive session type keeps it inactive", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    const card = await findCard(page);
    await card.getByLabel("Edit session type").click();
    await page.locator("#st-duration").fill("35");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("#st-duration")).toHaveCount(0, { timeout: 15_000 });

    const list = await owner.client.get<{ data: { id: string; active: boolean; durationMin: number }[] }>("/session-types");
    const row = list.body.data.find((s) => s.id === sessionTypeId)!;
    expect(row.durationMin).toBe(35);
    expect(row.active).toBe(false);
  });

  test("O1 — an inactive session type's sessions are not offered to clients (not in the client session list)", async () => {
    const client = await signInAs("client");
    const res = await client.client.get<{ data: { sessionTypeId: string }[] }>("/sessions");
    expect(res.status).toBe(200);
    const items = Array.isArray(res.body.data) ? res.body.data : [];
    expect(items.some((s) => s.sessionTypeId === sessionTypeId)).toBe(false);
  });

  test("G6 — ticking Active again removes the badge and dimming", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    let card = await findCard(page);
    await card.getByLabel("Edit session type").click();
    await activeBox(page).check();
    await page.getByRole("button", { name: "Save changes" }).click();

    card = await findCard(page);
    await expect(card.getByText("Inactive")).toHaveCount(0, { timeout: 15_000 });
    const list = await owner.client.get<{ data: { id: string; active: boolean }[] }>("/session-types");
    expect(list.body.data.find((s) => s.id === sessionTypeId)?.active).toBe(true);
  });
});
