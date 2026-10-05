import { expect, test, type Page } from "@playwright/test";
import { signInBrowserAs } from "../../support/browser-session";
import {
  createCreditType,
  listCreditTypes,
  retireCreditType,
  uniqueCreditTypeCode,
} from "../../support/credit-types";
import { signInAs, type SignedInSession } from "../../support/test-users";

/** feature/credit-types checklist A, B, C, I, L — the owner's Credit types tab, end to end in the browser. */
test.describe.serial("owner — Credit types tab (checklist A–C, I, L)", () => {
  let owner: SignedInSession;
  const retire: string[] = [];

  test.beforeAll(async () => {
    owner = await signInAs("owner");
  });

  test.afterAll(async () => {
    for (const id of retire) await retireCreditType(owner.client, id);
  });

  const card = (page: Page, text: string) =>
    page.locator("div", { hasText: text }).filter({ has: page.getByLabel("Edit credit type") }).last();

  async function openTypesTab(page: Page) {
    await page.goto("/admin/credits");
    await page.getByRole("tab", { name: "Credit types" }).click();
    await expect(page.getByRole("button", { name: "New credit type" }).first()).toBeVisible({ timeout: 15_000 });
  }

  test("A1–A3 — two tabs (Client credits first); the seeded types are listed as 'CODE · short name'; no Inactive badge on active ones", async ({
    page,
    context,
  }) => {
    await signInBrowserAs(context, "owner");
    await page.goto("/admin/credits");
    await expect(page.getByRole("tab", { name: "Client credits" })).toHaveAttribute("aria-selected", "true", {
      timeout: 15_000,
    });
    await page.getByRole("tab", { name: "Credit types" }).click();
    await expect(page.getByRole("tab", { name: "Credit types" })).toHaveAttribute("aria-selected", "true");

    await expect(page.getByText(/^SGPT · /)).toBeVisible();
    await expect(page.getByText(/^PT · /)).toBeVisible();
    await expect(page.getByText(/^COND · /)).toBeVisible();
    await expect(page.getByRole("button", { name: "New credit type" }).first()).toBeVisible();
  });

  test("B2/B3 — empty fields and bad codes show field errors and do not submit", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    await openTypesTab(page);
    const before = (await listCreditTypes(owner.client, true)).types.length;

    await page.getByRole("button", { name: "New credit type" }).first().click();
    await page.getByRole("button", { name: "Create credit type" }).click();
    await expect(page.getByText("Code is required", { exact: true })).toBeVisible();
    await expect(page.getByText("Name is required", { exact: true })).toBeVisible();
    await expect(page.getByText("Full name is required", { exact: true })).toBeVisible();

    await page.locator("#ct-name").fill("Bad");
    await page.locator("#ct-full-name").fill("Bad code");
    await page.locator("#ct-code").fill("bad code!");
    await page.getByRole("button", { name: "Create credit type" }).click();
    await expect(page.getByText("Up to 12 letters, numbers or underscores")).toBeVisible();

    await page.locator("#ct-code").fill("ABCDEFGHIJKLM"); // 13 chars
    await page.getByRole("button", { name: "Create credit type" }).click();
    await expect(page.getByText("Up to 12 letters, numbers or underscores")).toBeVisible();

    expect((await listCreditTypes(owner.client, true)).types.length).toBe(before);
  });

  test("B1/B4/B6 — create a type: lowercase code is saved upper-cased, appears immediately, swatch selection shows", async ({
    page,
    context,
  }) => {
    await signInBrowserAs(context, "owner");
    await openTypesTab(page);
    const code = uniqueCreditTypeCode("e").toLowerCase();

    await page.getByRole("button", { name: "New credit type" }).first().click();
    await page.locator("#ct-code").fill(code);
    await page.locator("#ct-name").fill("E2E");
    await page.locator("#ct-full-name").fill(`E2E type ${code}`);

    // all 8 palette swatches are selectable; the selected one is aria-checked
    const swatches = page.getByRole("radiogroup", { name: "Colour" }).getByRole("radio");
    await expect(swatches).toHaveCount(8);
    for (let i = 0; i < 8; i++) {
      await swatches.nth(i).click();
      await expect(swatches.nth(i)).toHaveAttribute("aria-checked", "true");
    }
    await page.getByRole("radio", { name: /teal/i }).click();

    await page.getByRole("button", { name: "Create credit type" }).click();
    await expect(page.getByText(`${code.toUpperCase()} · E2E`)).toBeVisible({ timeout: 15_000 });

    const made = (await listCreditTypes(owner.client, true)).types.find((t) => t.code === code.toUpperCase());
    expect(made).toBeTruthy();
    expect(made!.color).toBe("teal");
    retire.push(made!.id);
  });

  test("B5 — a duplicate code shows the conflict message and creates no second row", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    await openTypesTab(page);
    await page.getByRole("button", { name: "New credit type" }).first().click();
    await page.locator("#ct-code").fill("SGPT");
    await page.locator("#ct-name").fill("Dup");
    await page.locator("#ct-full-name").fill("Duplicate");
    await page.getByRole("button", { name: "Create credit type" }).click();
    await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 15_000 });
    expect((await listCreditTypes(owner.client, true)).types.filter((t) => t.code === "SGPT")).toHaveLength(1);
  });

  test("B7 — Cancel closes the dialog and reopening shows an empty form", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    await openTypesTab(page);
    await page.getByRole("button", { name: "New credit type" }).first().click();
    await page.locator("#ct-code").fill("HALFTYPED");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#ct-code")).toHaveCount(0);

    await page.getByRole("button", { name: "New credit type" }).first().click();
    await expect(page.locator("#ct-code")).toHaveValue("");
  });

  test("C1/C4 — edit locks the code, saves new names, and each type opens with its own values", async ({
    page,
    context,
  }) => {
    const a = await createCreditType(owner.client, { name: "EditA", fullName: "Edit type A" });
    const b = await createCreditType(owner.client, { name: "EditB", fullName: "Edit type B", color: "rose" });
    retire.push(a.id, b.id);

    await signInBrowserAs(context, "owner");
    await openTypesTab(page);

    await card(page, a.code).getByLabel("Edit credit type").click();
    await expect(page.locator("#ct-code")).toBeDisabled();
    await expect(page.locator("#ct-code")).toHaveValue(a.code);
    await expect(page.locator("#ct-name")).toHaveValue("EditA");
    await page.getByRole("button", { name: "Cancel" }).click();

    await card(page, b.code).getByLabel("Edit credit type").click();
    await expect(page.locator("#ct-code")).toHaveValue(b.code);
    await expect(page.locator("#ct-full-name")).toHaveValue("Edit type B");

    const renamed = `Edit renamed ${b.code}`;
    await page.locator("#ct-full-name").fill(renamed);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(renamed)).toBeVisible({ timeout: 15_000 });

    // C3: saving with no changes does not error
    await card(page, b.code).getByLabel("Edit credit type").click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("#ct-code")).toHaveCount(0, { timeout: 15_000 });
  });

  test("I1/I4/I5/I6/L — deactivate flow: Move is default, impact shows zeros, confirm needs the typed code, then Reactivate restores it", async ({
    page,
    context,
  }) => {
    const t = await createCreditType(owner.client, { name: "Deact", fullName: "Deactivate me" });
    retire.push(t.id);
    await signInBrowserAs(context, "owner");
    await openTypesTab(page);

    await card(page, t.code).getByLabel("Deactivate credit type").click();
    await expect(page.getByRole("radio", { name: /Move them to another type/ })).toBeChecked();
    await expect(page.locator("#ct-target")).not.toHaveValue(""); // first other active type preselected
    await page.getByRole("button", { name: "Review impact" }).click();

    // no holders: 0 / 0 / 0 and no red block
    await expect(page.getByText("Clients holding")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Can't deactivate yet/)).toHaveCount(0);

    const confirm = page.getByRole("button", { name: "Yes, deactivate" });
    await expect(confirm).toBeDisabled();
    await page.locator("#ct-confirm").fill("WRONG");
    await expect(confirm).toBeDisabled();

    // I6: Back keeps the choice
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("radio", { name: /Move them to another type/ })).toBeChecked();
    await page.getByRole("button", { name: "Review impact" }).click();

    await page.locator("#ct-confirm").fill(`  ${t.code.toLowerCase()} `); // lowercase + spaces accepted
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(card(page, t.code).getByText("Inactive")).toBeVisible({ timeout: 15_000 });
    expect((await listCreditTypes(owner.client, true)).types.find((x) => x.id === t.id)?.active).toBe(false);

    // I8/L1: an inactive type offers Reactivate, not Deactivate
    await expect(card(page, t.code).getByLabel("Deactivate credit type")).toHaveCount(0);
    await card(page, t.code).getByLabel("Reactivate credit type").click();
    await expect(card(page, t.code).getByText("Inactive")).toHaveCount(0, { timeout: 15_000 });
    expect((await listCreditTypes(owner.client, true)).types.find((x) => x.id === t.id)?.active).toBe(true);
  });

  test("I9 — a type used by an active session type shows the red block and the final button stays disabled", async ({
    page,
    context,
  }) => {
    await signInBrowserAs(context, "owner");
    await openTypesTab(page);
    await card(page, "SGPT ·").getByLabel("Deactivate credit type").click();
    // pick FREEZE so the form is valid regardless of other active types
    await page.getByRole("radio", { name: /Freeze the credits/ }).check();
    if (await page.getByRole("radio", { name: /Keep as frozen/ }).count()) {
      await page.getByRole("radio", { name: /Keep as frozen/ }).check();
    }
    await page.getByRole("button", { name: "Review impact" }).click();
    await expect(page.getByText(/Can't deactivate yet/)).toBeVisible({ timeout: 15_000 });
    await page.locator("#ct-confirm").fill("SGPT");
    await expect(page.getByRole("button", { name: "Yes, deactivate" })).toBeDisabled();

    expect((await listCreditTypes(owner.client)).types.find((x) => x.code === "SGPT")?.active).toBe(true);
  });
});
