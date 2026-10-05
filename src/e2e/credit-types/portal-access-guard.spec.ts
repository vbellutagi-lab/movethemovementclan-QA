import { expect, test } from "@playwright/test";
import { signInBrowserAs } from "../../support/browser-session";

/** feature/credit-types checklist U (portal access guard) and A4/A5. */
test.describe("portal access guard — wrong role sees 'Not authorized', not the portal chrome (checklist U, A4, A5)", () => {
  const notAuthorized = (page: import("@playwright/test").Page) =>
    page.getByRole("heading", { name: "Not authorized" });

  test("U1/A5 — a client opening /admin/credits sees Not authorized with no sidebar or dashboard chrome", async ({
    page,
    context,
  }) => {
    await signInBrowserAs(context, "client");
    await page.goto("/admin/credits");
    await expect(notAuthorized(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab", { name: "Credit types" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Go to my portal" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  for (const path of [
    "/admin",
    "/admin/session-types",
    "/admin/packages",
    "/admin/centres",
    "/admin/payments",
    "/staff",
    "/staff/credits",
    "/staff/schedule",
  ]) {
    test(`U2/U4 — a client opening ${path} is not authorized`, async ({ page, context }) => {
      await signInBrowserAs(context, "client");
      await page.goto(path);
      await expect(notAuthorized(page)).toBeVisible({ timeout: 15_000 });
    });
  }

  for (const who of ["coach", "staff"] as const) {
    test(`U3/A4 — ${who} opening /admin/credits is not authorized`, async ({ page, context }) => {
      await signInBrowserAs(context, who);
      await page.goto("/admin/credits");
      await expect(notAuthorized(page)).toBeVisible({ timeout: 15_000 });
    });

    test(`U8/A4 — ${who} still reaches /staff/credits, which has no Credit types tab`, async ({ page, context }) => {
      await signInBrowserAs(context, who);
      await page.goto("/staff/credits");
      await expect(notAuthorized(page)).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Credit types" })).toHaveCount(0, { timeout: 15_000 });
      await expect(page).toHaveURL(/\/staff\/credits$/);
    });
  }

  test("U5 — 'Go to my portal' sends a client to the client portal", async ({ page, context }) => {
    await signInBrowserAs(context, "client");
    await page.goto("/admin/credits");
    await page.getByRole("button", { name: "Go to my portal" }).click();
    await expect(page).toHaveURL(/\/client/, { timeout: 15_000 });
  });

  test("U5 — 'Go to my portal' sends a coach to /staff", async ({ page, context }) => {
    await signInBrowserAs(context, "coach");
    await page.goto("/admin/credits");
    await page.getByRole("button", { name: "Go to my portal" }).click();
    await expect(page).toHaveURL(/\/staff/, { timeout: 15_000 });
  });

  test("U6 — 'Sign out' signs out and lands on the sign-in page", async ({ browser }) => {
    // A private context: signing out revokes the session, which must not be the shared cached one.
    const { createVerifiedEnrolledClient } = await import("../../support/fixtures");
    const fresh = await createVerifiedEnrolledClient("ct-signout");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/sign-in");
    await page.locator("#email").fill(fresh.email);
    await page.locator("#password").fill(fresh.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/sign-in$/, { timeout: 15_000 });

    await page.goto("/admin/credits");
    await expect(notAuthorized(page)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
    await context.close();
  });

  test("U7 — the owner opens /admin/... and /staff/... as before", async ({ page, context }) => {
    await signInBrowserAs(context, "owner");
    for (const path of ["/admin/credits", "/admin/session-types", "/admin/packages", "/staff/credits"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Not authorized" })).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 15_000 });
    }
  });

  test("U9 — a signed-out visitor to /admin/credits is redirected to sign-in", async ({ page }) => {
    await page.goto("/admin/credits");
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 15_000 });
    await expect(notAuthorized(page)).toHaveCount(0);
  });

  test("U11 — the client's own pages are unaffected", async ({ page, context }) => {
    await signInBrowserAs(context, "client");
    for (const path of ["/client", "/client/sessions", "/client/packages"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 15_000 });
      await expect(notAuthorized(page)).toHaveCount(0);
    }
  });
});
