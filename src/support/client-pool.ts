import type { ApiClient } from "./api-client";
import { createVerifiedEnrolledClient } from "./fixtures";
import { loadCachedSession, storeCachedSession } from "./session-cache";
import { getClientProfile, signInAs } from "./test-users";

/**
 * A reusable pool of N genuinely-distinct, verified, enrolled client identities — the fixture
 * the capacity/oversubscription suite needs, where "10 clients hit one session at once" has to
 * mean ten real `clients` rows with ten real sessions, not one client retrying ten times (which
 * the client-row lock + overlap check would reject for entirely different reasons).
 *
 * ## Why this is cached on disk
 *
 * Standing up one pool member costs two calls to the rate-limited auth surface (sign-up, then
 * sign-in after email verification), and apps/api/src/middleware/rate-limit.ts caps
 * sign-in+sign-up at **5 per hour per IP**. A 10-member pool therefore costs 20 auth calls —
 * four hours of waiting out the limiter on every run, which would make this suite unrunnable.
 *
 * So pool members are provisioned **once** and their session cookies persisted to `.qa-cache`
 * (Better Auth sessions last 7 days). Steady-state runs spend **zero** auth calls: they reload
 * cookies from disk and re-validate them via the un-rate-limited `/get-session`.
 *
 * ## Why provisioning sends an `x-forwarded-for`
 *
 * Even a once-per-week provisioning run needs 20 auth calls back to back. Each pool member is
 * therefore provisioned behind its own synthetic `x-forwarded-for`, which lands it in its own
 * IP-keyed limiter bucket (2 calls of its 5/hr budget) instead of all ten sharing the runner's.
 *
 * This works because apps/api/src/server.ts sets `app.set("trust proxy", 1)` — correct when the
 * API sits behind exactly one reverse proxy (ALB/nginx), but it means that when the API is
 * reachable *directly*, as it is in local dev, a caller can choose its own rate-limit bucket by
 * forging the header. **That is a real finding about the limiter, not just a test convenience**
 * — see docs/scenarios.md §5. This suite leans on it deliberately and noisily (it warns on every
 * provisioning run); set `QA_POOL_SOURCE_IPS=false` to provision honestly from the runner's real
 * IP instead and wear the ~4h of limiter backoff (pair it with `QA_AUTOWAIT_RATE_LIMIT=true`).
 *
 * Note this affects **provisioning only**. The booking race itself is not auth-traffic and is
 * not rate-limited on that path; the forged header just keeps ten concurrent bookers out of one
 * shared 100-requests/minute general bucket, which is also what ten real clients would look like.
 */
const USE_DISTINCT_SOURCE_IPS = process.env.QA_POOL_SOURCE_IPS !== "false";

/** Documentation-range address (RFC 5737 TEST-NET-3) — never a real host, even by accident. */
function sourceIpFor(index: number): string {
  return `203.0.113.${index + 20}`;
}

function headersFor(index: number): Record<string, string> {
  return USE_DISTINCT_SOURCE_IPS ? { "x-forwarded-for": sourceIpFor(index) } : {};
}

export interface PooledClient {
  label: string;
  /** Signed-in HTTP client for this identity. */
  client: ApiClient;
  /** The domain `clients.id` row — what /credits/grant and bookings key on, NOT `user.id`. */
  clientId: string;
  email: string;
}

const poolPromises = new Map<number, Promise<PooledClient[]>>();

/**
 * Returns `size` distinct pooled client identities, provisioning any that aren't already
 * cached. Memoised per-process as well as on disk, so several tests in a file share one pool.
 */
export function getBookingClientPool(size: number): Promise<PooledClient[]> {
  let existing = poolPromises.get(size);
  if (!existing) {
    existing = provisionPool(size);
    poolPromises.set(size, existing);
  }
  return existing;
}

async function provisionPool(size: number): Promise<PooledClient[]> {
  const pool: PooledClient[] = [];
  let provisionedThisRun = 0;

  // Deliberately sequential. Provisioning walks sign-up → Mailpit poll → verify → sign-in, and
  // a burst of ten of those in parallel makes the Mailpit search race (several unverified
  // users' emails landing at once) for no real gain on a once-a-week code path.
  for (let i = 0; i < size; i++) {
    const label = `pool-booker-${i}`;
    const cacheKey = `pool:booker:${i}`;
    const headers = headersFor(i);

    const cached = await loadCachedSession(cacheKey, headers);
    if (cached) {
      pool.push({
        label,
        client: cached.client,
        clientId: (await getClientProfile(cached.client)).id,
        email: cached.email,
      });
      continue;
    }

    if (provisionedThisRun === 0 && USE_DISTINCT_SOURCE_IPS) {
      console.warn(
        `[client-pool] Provisioning new pool members. Each is signed up behind its own ` +
          `synthetic x-forwarded-for so it gets its own 5/hr auth-limiter bucket — this ` +
          `relies on the API trusting a forged proxy header when reached directly ` +
          `(docs/scenarios.md §5). Set QA_POOL_SOURCE_IPS=false to provision from the real IP.`,
      );
    }
    provisionedThisRun++;

    const fresh = await createVerifiedEnrolledClient(label, { defaultHeaders: headers });
    const profile = await getClientProfile(fresh.client);
    storeCachedSession(cacheKey, {
      client: fresh.client,
      userId: profile.userId,
      email: fresh.email,
    });
    pool.push({ label, client: fresh.client, clientId: profile.id, email: fresh.email });
  }

  return pool;
}

interface BalanceResponse {
  data: { balances: Array<{ creditType: string; balance: number }> };
}

/** That client's own spendable balance for one credit type (0 if it holds none). */
export async function readBalance(client: ApiClient, creditType: string): Promise<number> {
  const res = await client.get<BalanceResponse>("/credits/my-balances");
  if (res.status !== 200) {
    throw new Error(`GET /credits/my-balances failed: HTTP ${res.status} ${res.rawText.slice(0, 200)}`);
  }
  return res.body?.data?.balances?.find((b) => b.creditType === creditType)?.balance ?? 0;
}

/**
 * Tops every pooled client up to at least `minBalance` spendable credits of `creditType`.
 *
 * Critical for capacity tests: a racer that loses because it ran out of credits (400) rather
 * than because the session was full (409) would quietly prove the wrong thing. Every racer must
 * enter the race *able* to book, so capacity is provably the only binding constraint.
 *
 * Tops up rather than granting a flat amount each run, because a losing racer never spends its
 * credit — a flat grant would inflate balances without bound across runs.
 */
export async function ensurePoolCredits(
  pool: PooledClient[],
  creditType: string,
  minBalance: number,
): Promise<void> {
  const owner = await signInAs("owner");

  await Promise.all(
    pool.map(async (member) => {
      const balance = await readBalance(member.client, creditType);
      if (balance >= minBalance) return;

      const res = await owner.client.post("/credits/grant", {
        clientId: member.clientId,
        creditType,
        amount: minBalance - balance,
        expiresAt: null,
        centreScope: null,
        reason: `QA capacity-suite top-up for ${member.label}`,
      });
      if (res.status !== 200) {
        throw new Error(
          `Could not top ${member.label} up to ${minBalance} ${creditType} credits: ` +
            `HTTP ${res.status} ${res.rawText.slice(0, 200)}`,
        );
      }
    }),
  );
}
