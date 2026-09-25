import { expect, test } from "@playwright/test";
import { createVerifiedEnrolledClient } from "../../support/fixtures";
import { waitForMessage } from "../../support/mailpit";

/**
 * ChangePasswordForm (apps/web/app/components/change-password-form.tsx) calls Better Auth's
 * authClient.changePassword({ revokeOtherSessions: true }) directly — the UI copy promises
 * "This signs you out of every other device." Live finding (docs/scenarios.md §2.11, fully
 * characterized in src/integration/security/session-revocation.test.ts): that promise does NOT
 * hold immediately — a second device stays fully signed in for up to ~5 minutes afterward
 * (packages/auth/server/index.ts's `cookieCache: { maxAge: 5 * 60 }` is trusted over a DB
 * re-check). This spec asserts that CURRENT behavior at the UI layer — a real user closing this
 * tab believing they're safe is not, for up to 5 minutes. Uses a fresh throwaway account (never
 * the shared client@move.dev seed login) since this test permanently mutates a password.
 */
test.describe("client password change — session revocation is NOT immediate, and a confirmation email is sent", () => {
  test("a second device stays signed in immediately after the password is changed elsewhere; a confirmation email is still sent", async ({
    browser,
  }) => {
    const since = Date.now();
    const { email, password } = await createVerifiedEnrolledClient("pwchange");
    const newPassword = "Qa-Rotated-Pass-2!";

    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext();
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    for (const page of [pageA, pageB]) {
      await page.goto("/sign-in");
      await page.locator("#email").fill(email);
      await page.locator("#password").fill(password);
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page).not.toHaveURL(/\/sign-in$/, { timeout: 10_000 });
    }

    // Device B: confirm it's genuinely signed in before the change (baseline for the revocation check).
    await pageB.goto("/client");
    await expect(pageB).not.toHaveURL(/\/sign-in$/);

    // Device A: change the password.
    await pageA.goto("/client/change-password");
    await pageA.locator("#current-password").fill(password);
    await pageA.locator("#new-password").fill(newPassword);
    await pageA.locator("#confirm-new-password").fill(newPassword);
    await pageA.getByRole("button", { name: /update password/i }).click();
    await expect(pageA.getByText(/^Updated$/)).toBeVisible({ timeout: 10_000 });

    // Finding: device B is still fully signed in — no immediate revocation despite the UI's
    // explicit "This signs you out of every other device" promise (see docs/scenarios.md §2.11).
    await pageB.goto("/client");
    await expect(pageB).not.toHaveURL(/\/sign-in$/, { timeout: 10_000 });
    await expect(pageB.getByText(/no client profile yet/i)).not.toBeVisible();

    // Second finding (docs/scenarios.md §2.12, fully characterized in session-revocation.test.ts):
    // the "Your password was changed" confirmation email (commit 5764c7e) never actually arrives —
    // reproduced here through the real UI too, ruling out a test-fixture-specific cause.
    await expect(
      waitForMessage(email, { subjectMatch: /password/i, sinceMs: since, timeoutMs: 12_000 }),
    ).rejects.toThrow(/No message arrived/);

    await deviceA.close();
    await deviceB.close();

    // Old password is dead, new password works — confirms this wasn't just a UI-only success state.
    const finalCheck = await browser.newPage();
    await finalCheck.goto("/sign-in");
    await finalCheck.locator("#email").fill(email);
    await finalCheck.locator("#password").fill(password);
    await finalCheck.getByRole("button", { name: /sign in/i }).click();
    await expect(finalCheck.getByText(/something went wrong|invalid|incorrect/i)).toBeVisible({
      timeout: 10_000,
    });

    await finalCheck.goto("/sign-in");
    await finalCheck.locator("#email").fill(email);
    await finalCheck.locator("#password").fill(newPassword);
    await finalCheck.getByRole("button", { name: /sign in/i }).click();
    await expect(finalCheck).not.toHaveURL(/\/sign-in$/, { timeout: 10_000 });
    await finalCheck.close();
  });
});
