import { expect, test } from "@playwright/test";

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "ChangeMe123!";

test.describe("sign-in — through the real web UI (docs/scenarios.md, auth-qa-manual.html §3)", () => {
  test("signs in with valid seed credentials and leaves the sign-in page", async ({ page }) => {
    await page.goto("/sign-in");
    await page.locator("#email").fill("client@move.dev");
    await page.locator("#password").fill(SEED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).not.toHaveURL(/\/sign-in$/, { timeout: 10_000 });
  });

  test("wrong password shows an error and does not navigate away", async ({ page }) => {
    await page.goto("/sign-in");
    await page.locator("#email").fill("client@move.dev");
    await page.locator("#password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/something went wrong|invalid|incorrect/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("SEC-AUTH: sign-in error message does not confirm/deny whether the email exists (enumeration check)", async ({
    page,
  }) => {
    // security.html §4.1: "Authentication endpoints must not reveal whether an email or phone
    // number exists." Compare the error text for a real seed email + wrong password against a
    // clearly non-existent email + any password — they should read identically.
    await page.goto("/sign-in");
    await page.locator("#email").fill("client@move.dev");
    await page.locator("#password").fill("wrong-password-aaaa");
    await page.getByRole("button", { name: /sign in/i }).click();
    const existingEmailError = await page
      .getByText(/something went wrong|invalid|incorrect/i)
      .first()
      .textContent({ timeout: 10_000 });

    await page.goto("/sign-in");
    await page.locator("#email").fill("definitely-nobody-at-this-address@move-qa.test");
    await page.locator("#password").fill("wrong-password-aaaa");
    await page.getByRole("button", { name: /sign in/i }).click();
    const nonExistentEmailError = await page
      .getByText(/something went wrong|invalid|incorrect/i)
      .first()
      .textContent({ timeout: 10_000 });

    expect(nonExistentEmailError).toBe(existingEmailError);
  });
});
