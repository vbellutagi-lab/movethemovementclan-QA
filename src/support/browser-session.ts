import type { BrowserContext } from "@playwright/test";
import { env } from "./env";
import { signInAs, type SeedUserKey } from "./test-users";

/**
 * Signs a Playwright browser context in as a seed identity WITHOUT touching the sign-in form:
 * reuses the cached API session (session-cache.ts) and copies its cookies into the context.
 * Sign-in is rate-limited to 5/hr/IP (docs/scenarios.md §5), so UI-driving every spec through
 * the form would exhaust it. The form itself is covered by src/e2e/auth/sign-in.spec.ts.
 */
export async function signInBrowserAs(context: BrowserContext, key: SeedUserKey): Promise<void> {
  const session = await signInAs(key);
  const cookies = Object.entries(session.client.exportCookies()).map(([name, value]) => ({
    name,
    value,
    url: env.webBaseUrl,
  }));
  await context.addCookies(cookies);
}

/** Same idea for a throwaway account created through the API (its cookie jar is already signed in). */
export async function signInBrowserWithClient(
  context: BrowserContext,
  apiClient: import("./api-client").ApiClient,
): Promise<void> {
  const cookies = Object.entries(apiClient.exportCookies()).map(([name, value]) => ({
    name,
    value,
    url: env.webBaseUrl,
  }));
  await context.addCookies(cookies);
}
