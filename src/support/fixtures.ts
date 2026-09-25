import { newClient, type ApiClient } from "./api-client";
import { withAuthRateLimit } from "./auth-rate-limit";
import { env } from "./env";
import {
  getClientProfile,
  signIn,
  signInAs,
  setActiveOrganization,
  SEED_USERS,
  type SignedInSession,
} from "./test-users";
import { extractFirstUrl, waitForMessage } from "./mailpit";
import { uniqueEmail } from "./random";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
}
interface CentreInfo {
  id: string;
  name: string;
}

let seedOrgPromise: Promise<OrgInfo> | null = null;
let seedCentrePromise: Promise<CentreInfo> | null = null;

/** The seeded dev org (`move-dev`) — public lookup, no auth needed. Cached per process. */
export function getSeedOrg(): Promise<OrgInfo> {
  seedOrgPromise ??= (async () => {
    const anon = newClient();
    const res = await anon.get<{ data: OrgInfo | null }>(`/organizations/${env.seedOrgSlug}`);
    if (res.status !== 200 || !res.body?.data) {
      throw new Error(
        `Could not resolve seed org '${env.seedOrgSlug}' — is the target instance seeded ` +
          `(pnpm db:seed from apps/api)? HTTP ${res.status} ${res.rawText.slice(0, 300)}`,
      );
    }
    return res.body.data;
  })();
  return seedOrgPromise;
}

/** First centre of the seed org (there's exactly one in the dev seed: Koramangala). */
export function getSeedCentre(): Promise<CentreInfo> {
  seedCentrePromise ??= (async () => {
    const org = await getSeedOrg();
    const { client } = await signInAs("owner");
    const res = await client.get<{ data: CentreInfo[] }>(`/organizations/${org.slug}/centres`);
    const first = res.body?.data?.[0];
    if (res.status !== 200 || !first) {
      throw new Error(
        `Could not resolve any centre for seed org ${org.slug}: HTTP ${res.status} ${res.rawText.slice(0, 300)}`,
      );
    }
    return first;
  })();
  return seedCentrePromise;
}

let seedCoachIdPromise: Promise<string> | null = null;

/**
 * The seeded coach's `coaches.id` (NOT `user.id`) — resolved via the seed client's own
 * `assignedCoachId` rather than the coaches router, so this fixture has no dependency on
 * that router's own authz being correct. `clients.enroll`'s `coachId` field became required
 * once staff-add started always requiring an owner-picked coach (see
 * packages/trpc/server/routes/clients/model.ts's `enrollInputModel`).
 */
export function getSeedCoachId(): Promise<string> {
  seedCoachIdPromise ??= (async () => {
    const { client } = await signInAs("client");
    const profile = await getClientProfile(client);
    if (!profile.assignedCoachId) {
      throw new Error("Seed client client@move.dev has no assignedCoachId — reseed the DB.");
    }
    return profile.assignedCoachId;
  })();
  return seedCoachIdPromise;
}

/**
 * Signs up a brand-new user through the real HTTP sign-up + email-verification flow (Mailpit
 * catches the verification email — see docker-compose.yml), then self-enrolls it as a client
 * of the seed org's only centre. Used whenever a test needs to mutate account-level state
 * (password, profile) without touching a shared seed login every other suite/dev depends on.
 */
/**
 * Signs up a brand-new user through the real HTTP sign-up + email-verification flow (Mailpit
 * catches the verification email — see docker-compose.yml) and returns a signed-in client for
 * it. No org membership, no client/coach profile — just a real, verified account. The building
 * block under createVerifiedEnrolledClient and any coach/staff onboarding fixture.
 */
export async function createVerifiedUser(
  labelPrefix: string,
  opts: { defaultHeaders?: Record<string, string> } = {},
): Promise<{ client: ApiClient; email: string; password: string; userId: string }> {
  const email = uniqueEmail(labelPrefix);
  const password = "Qa-Fresh-Pass-1!";
  const since = Date.now();
  const defaultHeaders = opts.defaultHeaders ?? {};

  const anon = newClient(defaultHeaders);
  const signUpRes = await withAuthRateLimit(`sign-up(${email})`, () =>
    anon.authPost("/sign-up/email", { email, password, name: labelPrefix }),
  );
  if (signUpRes.status !== 200) {
    throw new Error(
      `Sign-up failed for ${email}: HTTP ${signUpRes.status} ${signUpRes.rawText.slice(0, 300)}`,
    );
  }

  const message = await waitForMessage(email, { subjectMatch: /verify/i, sinceMs: since });
  const verifyUrl = extractFirstUrl(message.Text);
  const verifyRes = await fetch(verifyUrl, { redirect: "manual" });
  if (verifyRes.status >= 400) {
    throw new Error(`Visiting the verification link failed: HTTP ${verifyRes.status}`);
  }

  const client = newClient(defaultHeaders);
  const signInRes = await withAuthRateLimit(`sign-in-after-verify(${email})`, () =>
    client.authPost<{ user?: { id: string } }>("/sign-in/email", { email, password }),
  );
  if (signInRes.status !== 200 || !signInRes.body?.user?.id) {
    throw new Error(
      `Sign-in after verification failed for ${email}: HTTP ${signInRes.status} ` +
        signInRes.rawText.slice(0, 300),
    );
  }

  return { client, email, password, userId: signInRes.body.user.id };
}

/** createVerifiedUser, then self-enrolled as a client of the seed org's only centre. */
export async function createVerifiedEnrolledClient(
  labelPrefix: string,
  opts: { defaultHeaders?: Record<string, string> } = {},
): Promise<{ client: ApiClient; email: string; password: string }> {
  const fresh = await createVerifiedUser(labelPrefix, opts);

  const centreId = (await getSeedCentre()).id;
  const joinRes = await fresh.client.post("/clients/join", { homeCentreId: centreId });
  if (joinRes.status !== 200) {
    throw new Error(
      `clients.join failed for fresh user ${fresh.email}: HTTP ${joinRes.status} ` +
        joinRes.rawText.slice(0, 300),
    );
  }

  return fresh;
}

/**
 * Invites a brand-new verified user into the seed org as an org-role "member", then completes
 * their coach profile at the seed centre (coaches.completeProfile) — a genuine SECOND coach in
 * the seed org, distinct from coach@move.dev. Needed for coach-scoping tests where "assigned to
 * a different coach" must be a real, different coach, not just "unassigned" (the seed centre's
 * only other coach slot would otherwise auto-absorb every self-joined client — see
 * ClientsService.enrollClient's resolveCoachForCentre fallback).
 */
export async function createSecondSeedOrgCoach(
  labelPrefix: string,
): Promise<{ session: SignedInSession; coachId: string }> {
  // Unique display name (not just email) — coaches.list is unfiltered by org (docs/scenarios.md
  // §1.14), so a run-scoped name avoids colliding with same-labelled coaches from other orgs
  // created elsewhere in the same test run.
  const uniqueName = `${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const fresh = await createVerifiedUser(uniqueName);
  const org = await getSeedOrg();
  const centre = await getSeedCentre();
  const { client: ownerClient } = await signInAs("owner");

  await inviteAndAccept(ownerClient, org.id, fresh, "member");
  await setActiveOrganization(fresh.client, org.id);

  const res = await fresh.client.post<{ data: null }>("/coaches/complete-profile", {
    centreId: centre.id,
  });
  if (res.status !== 200) {
    throw new Error(
      `coaches.complete-profile failed for ${fresh.email}: HTTP ${res.status} ` +
        res.rawText.slice(0, 300),
    );
  }

  const list = await ownerClient.get<{ data: Array<{ id: string; name: string }> }>("/coaches");
  const coach = list.body?.data?.find((c) => c.name === uniqueName);
  if (!coach) {
    throw new Error(`Could not resolve coaches.id for freshly-completed coach ${fresh.email}`);
  }

  return { session: fresh, coachId: coach.id };
}

/**
 * Provisions a second, throwaway organization the only way the running system allows over HTTP:
 * as a signed-in superadmin (`allowUserToCreateOrganization` gates `/organization/create` to
 * `user.role === "superadmin"`). Superadmin becomes its owner. Never touches the DB.
 */
export async function createTenantOrg(labelSuffix: string): Promise<{
  organizationId: string;
  slug: string;
  superadmin: SignedInSession;
}> {
  // Deliberately uncached (not signInAs) — this mutates the identity's active org away from the
  // seed org, and signInAs's cache is only safe for identities that stay at the seed-org default.
  const superadmin = await signIn(SEED_USERS.superadmin.email);
  const slug = `qa-tenant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const res = await superadmin.client.authPost<{ id: string; slug: string; name: string }>(
    "/organization/create",
    { name: `QA Tenant ${labelSuffix}`, slug },
  );
  if (res.status !== 200 || !res.body?.id) {
    throw new Error(
      `Failed to provision a second tenant org via /api/auth/organization/create: ` +
        `HTTP ${res.status} ${res.rawText.slice(0, 500)}`,
    );
  }

  // Superadmin is already a member of the seed org too (added as a second owner during seed —
  // see apps/api/src/scripts/seed/identity.ts), and a fresh session's `activeOrganizationId`
  // defaults to the EARLIEST-joined org, not the one just created. Without this, callers using
  // `superadmin.client` here would silently keep acting against the seed org, not the new one —
  // making a "cross-tenant" test accidentally same-tenant. Force it explicitly.
  await setActiveOrganization(superadmin.client, res.body.id);

  return { organizationId: res.body.id, slug: res.body.slug, superadmin };
}

/**
 * Adds an *already-authenticated, already-existing* user as a genuine member of `organizationId`
 * via the real invite → accept flow (Better Auth's `addMember` is server-only, not reachable over
 * HTTP — `invite-member` + `accept-invitation` is the only black-box path). Used to build a
 * "real admin of an unrelated org" identity for cross-tenant IDOR tests, as opposed to relying on
 * the platform-superadmin bypass (which is a separate, intentional axis — see ADR 0006/0015 — and
 * would not prove the same thing).
 */
export async function inviteAndAccept(
  inviterClient: import("./api-client").ApiClient,
  organizationId: string,
  invitee: SignedInSession,
  role: "member" | "admin" | "owner",
): Promise<void> {
  const inviteRes = await inviterClient.authPost<{ id: string }>("/organization/invite-member", {
    email: invitee.email,
    role,
    organizationId,
  });
  if (inviteRes.status !== 200 || !inviteRes.body?.id) {
    throw new Error(
      `invite-member failed for ${invitee.email} into ${organizationId}: HTTP ${inviteRes.status} ` +
        inviteRes.rawText.slice(0, 300),
    );
  }

  const acceptRes = await invitee.client.authPost("/organization/accept-invitation", {
    invitationId: inviteRes.body.id,
  });
  if (acceptRes.status !== 200) {
    throw new Error(
      `accept-invitation failed for ${invitee.email}: HTTP ${acceptRes.status} ` +
        acceptRes.rawText.slice(0, 300),
    );
  }
}

/**
 * The full cross-tenant "attacker" fixture used throughout src/integration/security: an existing
 * seeded user, genuinely admin/owner of a brand-new org that has zero relationship to the seed
 * org — verified live (see docs/scenarios.md §1) to reproduce real cross-tenant IDOR findings.
 */
export async function createUnrelatedOrgAdmin(
  seedUserKey: "coach" | "staff",
  role: "admin" | "owner" = "admin",
): Promise<{ session: SignedInSession; organizationId: string }> {
  const { organizationId, superadmin } = await createTenantOrg(`attacker-${seedUserKey}`);
  // Deliberately uncached (not signInAs) — same reason as createTenantOrg above: this session's
  // active org is about to be pointed at the throwaway attacker org, and other files' plain
  // signInAs(seedUserKey) calls must keep getting the seed org by default.
  const member = await signIn(SEED_USERS[seedUserKey].email);
  await inviteAndAccept(superadmin.client, organizationId, member, role);
  await setActiveOrganization(member.client, organizationId);
  return { session: member, organizationId };
}
