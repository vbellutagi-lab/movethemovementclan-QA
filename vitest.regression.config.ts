import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Used only by `npm run test:regression` (QA_AUTOWAIT_RATE_LIMIT=true). A plain `npm test` keeps
 * the base config's fast 20s timeouts for quick dev feedback — this config exists solely so a
 * test/hook that's mid-wait inside withAuthRateLimit (up to ~1hr, see src/support/auth-rate-limit.ts)
 * doesn't get killed by vitest's own per-test timeout before the real API rate limit clears.
 * CLI flags (--testTimeout=...) were tried first and did NOT reliably override the config file's
 * testTimeout in this vitest version — a dedicated config file is the version-proof way to do it.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 70 * 60_000,
      hookTimeout: 70 * 60_000,
    },
  }),
);
