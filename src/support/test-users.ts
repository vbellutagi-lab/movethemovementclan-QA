import { ApiClient, newClient } from "./api-client";
import { withAuthRateLimit } from "./auth-rate-limit";
import { env } from "./env";
import { loadCachedSession, storeCachedSession } from "./session-cache";

/** Dev logins created by apps/api/src/scripts/seed (packages/database seed script). */
export const SEED_USERS = {
  superadmin: { email: "superadmin@move.dev", label: "platform superadmin, not an org member" },
  owner: { email: "owner@move.dev", label: "org owner" },
  coach: { email: "coach@move.dev", label: "coach (org member role)" },
  staff: { email: "staff@move.dev", label: "front-desk staff (org member role)" },
  client: { email: "client@move.dev", label: "gym customer / client" },
  // Added with feature/credit-types' fuller seed: a second coach and two more clients (client3 belongs to coach2).
  coach2: { email: "coach2@move.dev", label: "second coach (org member role)" },
  client2: { email: "client2@move.dev", label: "second client of coach 1" },
  client3: { email: "client3@move.dev", label: "client of coach 2" },
} as const;

export type SeedUserKey = keyof typeof SEED_USERS;

export interface SignedInSession {
  client: ApiClient;
  userId: string;
  email: string;
}

/**
 * Signs in through the real Better Auth REST endpoint (never a shortcut) and returns a
 * ready-to-use client whose cookie jar carries the resulting session. Throws loudly on
 * failure so a broken fixture never silently degrades a later assertion into a false pass.
 */
export async function signIn(email: string, password: string = env.seedPassword): Promise<SignedInSession> {
  const client = newClient();
  const res = await withAuthRateLimit(`sign-in(${email})`, () =>
    client.authPost<{ user?: { id: string; email: string } }>("/sign-in/email", { email, password }),
  );
  if (res.status !== 200 || !res.body?.user?.id) {
    throw new Error(
      `Fixture sign-in failed for ${email}: HTTP ${res.status} ${res.rawText.slice(0, 300)}`,
    );
  }
  return { client, userId: res.body.user.id, email: res.body.user.email };
}

/**
 * Cached, shared sign-in for a seed identity — see session-cache.ts for why and its safety
 * scope. Only use this for "plain" role lookups. Anything that will call setActiveOrganization
 * to point the identity at a non-seed org (createTenantOrg, createUnrelatedOrgAdmin) must call
 * `signIn(SEED_USERS[key].email)` directly instead, to get an isolated, uncached session.
 */
export async function signInAs(key: SeedUserKey): Promise<SignedInSession> {
  const cacheKey = `seed:${key}`;
  const cached = await loadCachedSession(cacheKey);
  if (cached) return cached;

  const session = await signIn(SEED_USERS[key].email);
  storeCachedSession(cacheKey, session);
  return session;
}

export async function getSession(client: ApiClient) {
  return client.authGet<{
    session: { id: string; userId: string; activeOrganizationId?: string | null } | null;
    user: { id: string; email: string; role?: string } | null;
  } | null>("/get-session");
}

export async function setActiveOrganization(client: ApiClient, organizationId: string) {
  const res = await client.authPost("/organization/set-active", { organizationId });
  if (res.status !== 200) {
    throw new Error(
      `Failed to set active organization ${organizationId}: HTTP ${res.status} ${res.rawText.slice(0, 300)}`,
    );
  }
  return res;
}

export async function signOut(client: ApiClient) {
  return client.authPost("/sign-out", {});
}

export interface ClientProfile {
  id: string;
  userId: string;
  homeCentreId: string;
  assignedCoachId: string | null;
}

/** GET /api/clients/me — resolves the caller's own domain `clients` row (needs a client identity). */
export async function getClientProfile(client: ApiClient) {
  const res = await client.get<{ data: ClientProfile }>("/clients/me");
  if (res.status !== 200 || !res.body?.data) {
    throw new Error(`GET /clients/me failed: HTTP ${res.status} ${res.rawText.slice(0, 300)}`);
  }
  return res.body.data;
}
