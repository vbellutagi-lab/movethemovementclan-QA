import { describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createVerifiedUser } from "../../support/fixtures";
import { waitForMessage } from "../../support/mailpit";

/**
 * Live finding: `authClient.changePassword({ revokeOtherSessions: true })` — the exact call
 * ChangePasswordForm (apps/web/app/components/change-password-form.tsx) makes, whose UI copy
 * promises "This signs you out of every other device" — does NOT immediately invalidate a
 * second live session. A concurrently-signed-in session keeps full API access (confirmed here
 * via GET /api/auth/get-session AND a real protected tRPC call) for up to ~5 minutes afterward.
 *
 * Root cause, characterized via a one-time manual diagnostic (not re-run here — it takes 6
 * minutes and the cause is now well understood): packages/auth/server/index.ts configures
 * `cookieCache: { maxAge: 5 * 60 }` (5 minutes). The session middleware trusts that signed
 * cache instead of re-checking the session table on every request — exactly the tradeoff
 * documented for admin/staff privilege changes elsewhere in this codebase (see the comment at
 * packages/auth/server/index.ts:44, "Revocations/bans can take up to maxAge to [apply]"), but
 * ChangePasswordForm's copy doesn't reflect it, and revokeOtherSessions is specifically meant
 * to defend against a stolen/leaked session cookie — the exact threat model where a 5-minute
 * "still fully live" window matters most. Diagnostic confirmed the session DOES die at +6min
 * (past the cache TTL), so this is a bounded window, not a permanently broken feature.
 *
 * security.html §4.2: "Rotate the session identifier after... password changes." A same-second
 * rotation is what "revoke other sessions" implies; a multi-minute survival window is a real gap
 * against that requirement, even though it self-heals. P1 — see docs/scenarios.md §2.11.
 */
describe("session revocation on password change (docs/scenarios.md §2.11)", () => {
  it("a concurrently-signed-in session is still fully authenticated immediately after another device changes the password", async () => {
    const { email, password } = await createVerifiedUser("session-revoke");

    const deviceA = newClient();
    const deviceB = newClient();
    const signInA = await deviceA.authPost("/sign-in/email", { email, password });
    const signInB = await deviceB.authPost("/sign-in/email", { email, password });
    expect(signInA.status).toBe(200);
    expect(signInB.status).toBe(200);

    const beforeChange = await deviceB.authGet<{ session: unknown }>("/get-session");
    expect(beforeChange.body?.session).toBeTruthy();

    const changeRes = await deviceA.authPost("/change-password", {
      currentPassword: password,
      newPassword: "Qa-Rotated-Session-Test-2!",
      revokeOtherSessions: true,
    });
    expect(changeRes.status).toBe(200);

    // Finding: device B's session is untouched immediately after the change — no rotation, no
    // revocation, not even a delay of a few hundred ms. This is the current (undesired) behavior;
    // the secure expectation would be an immediate 401/null session here.
    const afterChange = await deviceB.authGet<{ session: unknown }>("/get-session");
    expect(afterChange.status).toBe(200);
    expect(afterChange.body?.session).toBeTruthy();

    const protectedCall = await deviceB.get("/clients/me");
    expect(protectedCall.status).not.toBe(401);
  }, 20_000);
});

/**
 * Separate live finding, discovered while investigating the above: the "Your password was
 * changed" confirmation email (commit 5764c7e, packages/auth/server/hooks/send-password-changed-email.ts)
 * never actually sends — reproduced both through the real web UI (src/e2e/client-portal/
 * change-password.spec.ts) and via a direct API call here, ruling out a frontend-specific cause.
 * Mailpit's delivery pipeline itself works (the sign-up verification email for the same test
 * user arrives fine seconds earlier), so this isn't an environment/SMTP issue.
 *
 * Likely root cause (not confirmed by adding server-side instrumentation — this is a QA-side
 * hypothesis for engineering to verify, not an asserted fact): `send-password-changed-email.ts`'s
 * hook only fires the email when the `account` object passed to `databaseHooks.account.update.before`
 * carries both a `password` string AND a `userId` string. If Better Auth's hook actually receives
 * only the changed-field delta being written (just `{ password: "<hash>" }`, no `userId`) rather
 * than the full account row, `accountUpdate.userId` is `undefined` and the function returns
 * silently on that check — exactly the kind of assumption the commit's own unit tests wouldn't
 * catch, since they mock `accountUpdate` as a full object including `userId`.
 */
describe("password-changed confirmation email (docs/scenarios.md §2.12)", () => {
  it("no confirmation email is sent after a successful password change", async () => {
    const since = Date.now();
    const { email, password, client } = await createVerifiedUser("pw-email-finding");

    const changeRes = await client.authPost("/change-password", {
      currentPassword: password,
      newPassword: "Qa-Rotated-Email-Test-1!",
      revokeOtherSessions: false,
    });
    expect(changeRes.status).toBe(200);

    await expect(
      waitForMessage(email, { subjectMatch: /password/i, sinceMs: since, timeoutMs: 12_000 }),
    ).rejects.toThrow(/No message arrived/);
  }, 20_000);
});
