import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newClient, type ApiClient } from "./api-client";

/**
 * Persists seed-identity session cookies to disk so `signInAs` only ever needs to hit the real
 * /sign-in endpoint once per identity, ever (not once per test file) — see docs/scenarios.md §5
 * and src/support/auth-rate-limit.ts for why: the app now rate-limits sign-in/sign-up to 5/hr/IP
 * combined, and this suite's own vitest globalSetup + every test file's beforeAll each used to
 * sign in fresh. The session cookie itself is valid for 7 days (Better Auth's Max-Age), so reuse
 * is safe as long as we re-validate liveness via /get-session (unlimited, not auth-rate-limited)
 * before trusting a cached entry.
 *
 * Deliberately NOT used for any identity whose active org gets mutated away from the seed org
 * (createTenantOrg's superadmin, createUnrelatedOrgAdmin's coach/staff) — those call sites use
 * the raw uncached `signIn` so they always get an isolated session, matching this suite's
 * existing assumption (documented in fixtures.ts) that signing in twice as the same seed user
 * yields two independent sessions. Caching only the "plain" role lookups keeps that guarantee
 * intact while still eliminating the vast majority of repeat sign-ins.
 */

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".qa-cache");
const CACHE_PATH = join(CACHE_DIR, "seed-sessions.json");

interface CacheEntry {
  cookies: Record<string, string>;
  userId: string;
  email: string;
  cachedAt: number;
}

export interface CachedSession {
  client: ApiClient;
  userId: string;
  email: string;
}

function readCache(): Record<string, CacheEntry> {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Returns a still-valid cached session for `key`, or null if there isn't one
 * (missing/stale/invalid). `defaultHeaders` are applied to the rebuilt client, so a caller
 * that provisioned an identity behind a particular transport identity (client-pool.ts's
 * per-client `x-forwarded-for`) gets that identity back on a cache hit too.
 */
export async function loadCachedSession(
  key: string,
  defaultHeaders: Record<string, string> = {},
): Promise<CachedSession | null> {
  const entry = readCache()[key];
  if (!entry) return null;

  const client = newClient(defaultHeaders);
  client.importCookies(entry.cookies);
  const res = await client.authGet<{ user: { id: string; email: string } | null }>("/get-session");
  if (res.status !== 200 || !res.body?.user?.id) return null;
  return { client, userId: res.body.user.id, email: res.body.user.email };
}

export function storeCachedSession(key: string, session: CachedSession): void {
  const cache = readCache();
  cache[key] = {
    cookies: session.client.exportCookies(),
    userId: session.userId,
    email: session.email,
    cachedAt: Date.now(),
  };
  writeCache(cache);
}
