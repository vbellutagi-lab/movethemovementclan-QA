import type { ApiResult } from "./api-client";

/**
 * apps/api/src/middleware/rate-limit.ts caps /api/auth/sign-in and /api/auth/sign-up combined
 * at 5 requests/hour, keyed by source IP (a real, deliberately-added control — see
 * docs/scenarios.md §5). This suite's fixtures collectively need more than 5 auth calls for a
 * full run, so a plain `npm test` fails fast on 429 by default (the honest, fast-feedback
 * behavior for day-to-day dev iteration). Set QA_AUTOWAIT_RATE_LIMIT=true (npm run test:regression
 * does this, with matching long timeouts) to instead wait out the limiter's own Retry-After and
 * resume automatically — for unattended full-suite runs where wall-clock time doesn't matter.
 */
const AUTOWAIT = process.env.QA_AUTOWAIT_RATE_LIMIT === "true";

/** Safety cap so a missing/bogus Retry-After header can't hang a run indefinitely. */
const MAX_WAIT_MS = 70 * 60_000;

export async function withAuthRateLimit<T>(
  label: string,
  attempt: () => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  for (;;) {
    const res = await attempt();
    if (res.status !== 429 || !AUTOWAIT) return res;

    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSec = Number(retryAfterHeader);
    const waitMs = Math.min(
      (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 3600) * 1000 + 2000,
      MAX_WAIT_MS,
    );
    console.warn(
      `[rate-limit] ${label} hit the auth limiter (5/hr/IP) — waiting ${Math.ceil(waitMs / 1000)}s before retrying...`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
