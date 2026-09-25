import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { signInAs, getSession, type SignedInSession } from "../../support/test-users";

describe("session cookie replay across clients (docs/scenarios.md §2.5)", () => {
  let client: SignedInSession;

  beforeAll(async () => {
    client = await signInAs("client");
  }, 30_000);

  it("a session cookie exported from one HTTP client and imported into a second, unrelated client is accepted identically", async () => {
    // Documents Better Auth's bearer-token-over-the-wire session model, not a bug: httpOnly
    // cookies carry no IP/device binding, so anything holding the cookie value is the session.
    const thief = newClient();
    thief.importCookies(client.client.exportCookies());

    const res = await getSession(thief);
    expect(res.status).toBe(200);
    expect(res.body?.user?.email).toBe("client@move.dev");

    const original = await getSession(client.client);
    expect(original.status).toBe(200);
    expect(original.body?.session?.id).toBe(res.body?.session?.id);
  });

  it("a tampered/garbage session cookie value is rejected, not silently treated as anonymous-but-valid", async () => {
    const tampered = newClient();
    tampered.setCookie("better-auth.session_token", "not-a-real-session-token");

    const res = await getSession(tampered);
    // get-session returns 200 with a null session/user for "no valid session", never a fake one.
    expect(res.status).toBe(200);
    expect(res.body?.user).toBeNull();
  });
});
