# movethemovementclan — QA automation

Black-box integration, e2e, and adversarial/security test suite for
[`movethemovementclan`](../movethemovementclan) — a multi-tenant fitness-studio booking platform
(Next.js + Express/tRPC + Postgres). This repo never imports the app's source or touches its
database directly: everything here talks to a **running instance** over HTTP (REST) and, for the
e2e layer, a real browser — exactly the vantage point a real user or attacker has.

Start with [`docs/scenarios.md`](docs/scenarios.md) — the threat-model/scenario catalog this suite
implements, including several **live-verified findings** (cross-tenant IDOR on `credits.*` and
`classTemplates.*`, an idempotency-key gap, an HTTP-status/error-taxonomy mismatch).

## Prerequisites

1. A running instance of `movethemovementclan`, seeded:
   ```bash
   cd ../movethemovementclan
   docker compose up -d          # Postgres :5434, Mailpit :8025
   pnpm install && pnpm db:migrate
   pnpm dev                       # api :8000, web :3000
   cd apps/api && pnpm db:seed    # creates move-dev org + superadmin/owner/coach/staff/client
   ```
2. Node 20+, and dependencies installed here:
   ```bash
   npm install
   npx playwright install --with-deps chromium   # only needed for the e2e (browser) suite
   cp .env.example .env                            # defaults already match the above
   ```

## Running

```bash
npm test              # integration suite (src/integration) — Vitest, real HTTP against the API
npm run test:security # just the adversarial/IDOR/authorization-matrix files
npm run e2e            # browser e2e suite (src/e2e) — Playwright against the web app
npm run typecheck
```

## Full regression before a deploy

```bash
npm run regression                    # prompts for a version/release label
npm run regression -- v1.2.0          # or pass it directly
npm run regression -- v1.2.0 --skip-integration   # e2e only
npm run regression -- v1.2.0 --skip-e2e           # integration only
```

Runs the integration suite (Vitest, API-level) and the e2e suite (Playwright, browser-level)
back to back and files everything under `test-results/<version>_<timestamp>/`:

```
test-results/v1.2.0_2026-09-25_15-45-57/
  SUMMARY.html                        the report — open this in a browser, read this first
  SUMMARY.md                          same summary as plain text/markdown
  integration/results.json            raw Vitest JSON results
  e2e/playwright-report/index.html    Playwright's own HTML report — open with:
                                       npx playwright show-report <path>
  e2e/test-results/                   failure screenshots, traces, video (per Playwright's
                                       screenshot: "only-on-failure" in playwright.config.ts) —
                                       SUMMARY.html embeds/links every screenshot from here
```

`SUMMARY.html` lists every test (file, release, time, failure details). Each test is stamped with
the release that introduced it via `test-releases.json` (unlisted tests count as `baseline`), and
failures are split into "introduced in this release" vs "pre-existing" so you can tell what blocks
a deploy. Regenerate an old run's report with `node scripts/run-regression.mjs --rebuild=<runId>`.

Nothing here overwrites a previous run — every run gets its own dated, versioned subfolder, so
past regression results stay around for comparison. `test-results/LATEST` always names the most
recent run. This folder isn't committed (see `.gitignore`); treat it as local/CI build output.

## Adding test cases for a new feature (tag → develop diff)

Before writing new test cases, get a summary of what actually changed in the app repo between
a released tag and `develop` (or a feature branch):

```bash
npm run diff:since-tag -- v1.1.0                       # v1.1.0..develop in ../movethemovementclan
npm run diff:since-tag -- v1.1.0 --branch=feature/x    # against a specific branch instead
npm run diff:since-tag -- v1.1.0 --app-repo=/path      # if the app repo isn't a sibling folder
```

This writes a commit log + changed-files stat to `docs/change-summaries/` (also not committed —
it's a working artifact, regenerate it whenever you need it). Review it, then ask Claude to draft
new integration/e2e test cases for each feature area it touches — the diffing is scripted, but
turning a diff into meaningful test cases is a judgment call best done per-feature, not blindly
automated.

The integration suite runs files **sequentially** (`fileParallelism: false` in
`vitest.config.ts`), deliberately — it drives one shared, real seeded org/client, not an isolated
DB per test file, so parallel files would race for the same bookable sessions and credit balance.
Every test that mutates state (books, cancels, grants, invites) cleans up after itself — the full
suite has been run back-to-back repeatedly during development with no manual reset required.

**This suite mutates real data.** Only ever point it at disposable dev/seed data — several
scenarios are deliberately destructive (credit grants/reversals, bookings, cancellations,
cross-tenant probes that create throwaway orgs). Never point `API_BASE_URL`/`WEB_BASE_URL` at
anything with real user data.

## Layout

```
docs/
  scenarios.md              threat model + scenario catalog (read this first)
src/
  support/                  black-box test harness — no app source imports
    api-client.ts             cookie-jar-aware HTTP client (/api/*, /api/auth/*, /trpc/*)
    test-users.ts              seeded dev identities (superadmin/owner/coach/staff/client)
    fixtures.ts                 org/centre discovery, cross-tenant org provisioning
    booking-helpers.ts           bookable-session lookup for tests
    client-pool.ts               a reusable pool of N distinct booking clients (see below)
    random.ts                    unique emails / idempotency keys / non-existent UUIDs
  integration/               Vitest — real HTTP against a running API, real Postgres
    security/                  cross-tenant IDOR, authorization matrix (the highest-value suite)
    bookings/                   happy path, negative, concurrency/race conditions, capacity
    credits/                    admin grant/reverse/extend-expiry
    clients/                    enrollment, self-service join
  e2e/                       Playwright — real browser against the Next.js web app
    auth/                       sign-in/sign-up flows through the actual UI
```

## The multi-client booking pool (`src/support/client-pool.ts`)

`src/integration/bookings/capacity.test.ts` needs **ten genuinely distinct clients** hitting one
session at once — ten real `clients` rows, not one client retrying ten times (which the
client-row lock rejects for entirely unrelated reasons).

Standing up one such client costs two calls to the rate-limited auth surface (sign-up, then
sign-in after email verification), and the app caps sign-in + sign-up at **5/hr/IP**. So pool
members are provisioned **once** and their session cookies cached in `.qa-cache`; steady-state
runs spend zero auth calls. Provisioning runs additionally give each member its own synthetic
`x-forwarded-for`, so each lands in its own limiter bucket instead of all ten sharing one — which
works only because the API trusts a forged proxy header when reached directly, itself a finding
(`docs/scenarios.md` §5.4). Set `QA_POOL_SOURCE_IPS=false` to provision from the real IP instead
and wear the limiter backoff (pair with `QA_AUTOWAIT_RATE_LIMIT=true`).

> ⚠️ **`capacity.test.ts` currently takes the API down.** Its two 10-client races trip a
> connection-pool deadlock (`docs/scenarios.md` §4.12) that leaves every database-backed route
> hanging until the API process is restarted. The file is ordered so the low-concurrency tests
> report first, and a stalled request fails with a diagnosis rather than hanging — but expect to
> restart `pnpm dev` after a full run until that bug is fixed.

## Why black-box, and why real HTTP against a live instance instead of mocks

The app's own unit tests (`packages/services/__tests__`, 99+ tests) already cover business logic
against a mocked `db`/`tx` — that's the right tool for pure logic, but structurally cannot catch
anything that only exists at the boundary between two real, concurrent HTTP requests hitting a
real Postgres instance: actual row-lock behavior under contention, actual cross-tenant
authorization holes, actual HTTP status codes as they cross the tRPC→OpenAPI→Express boundary.
Every finding in `docs/scenarios.md` marked 🔴 was discovered or confirmed by literally running
these tests against a live instance, not inferred from reading code — several **contradicted**
what the architecture docs claimed (`InsufficientCreditsError` documented as 422, actually 400;
idempotency-key handling documented as parameter-bound, actually key-only).

## A correction to the existing manual QA fixtures

`documents/test/move-api.postman_collection.json` (in the app repo) calls REST routes like
`{{baseUrl}}/bookings` and `{{baseUrl}}/credits/grant` — but the live server only mounts that
surface under `/api` (`apps/api/src/server.ts`: `app.use("/api", createOpenApiExpressMiddleware(...))`).
Every request in that collection as currently checked in would 404. This suite uses the correct
`/api` prefix throughout (see `src/support/api-client.ts`).
