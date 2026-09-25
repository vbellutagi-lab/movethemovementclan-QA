---
name: regression
description: Pre-deployment workflow for movethemovementclan — diff the tag currently in production against the code about to ship, draft new test cases for whatever features that diff contains, then run the full regression suite (integration + e2e) against a running instance and report pass/fail with links to the versioned report and failure screenshots. Use this whenever the user says they're about to deploy, wants a regression run, or asks to check nothing is broken before shipping.
argument-hint: [production tag, e.g. v1.1.0] [version label for this run, e.g. v1.2.0] [--skip-integration | --skip-e2e] [--skip-new-tests]
---

# Pre-deployment: new-feature tests + full regression

$ARGUMENTS

## What this does

Two phases, in order:

1. **Coverage phase** — diffs the tag currently deployed to production against the code about to
   be pushed (in `../movethemovementclan`), figures out which features that diff introduces, checks
   whether this suite already covers them, and drafts new test cases for the gaps.
2. **Regression phase** — runs `npm run regression` (Vitest integration + Playwright e2e against a
   running instance), filing results under `regression-runs/<version>_<timestamp>/` — a
   `SUMMARY.md`, the Playwright HTML report, failure screenshots/traces/video, and the integration
   suite's JSON results. See [README.md](../../README.md) for the full layout.

Skip phase 1 only if the user explicitly says to (`--skip-new-tests`) or says there's nothing new
since the last regression run.

## Phase 1 — new-feature test coverage

1. **Get the two refs.** Ask the user (if not already given via `$ARGUMENTS` or earlier in the
   conversation):
   - The tag **currently running in production** (e.g. `v1.1.0`) — this is the "before".
   - What's about to ship — usually `develop` or the current branch/HEAD in
     `../movethemovementclan`. Don't assume; ask if it isn't obvious.

   Do not guess the production tag — deploying against the wrong baseline defeats the point.

2. **Run the diff.**
   ```bash
   npm run diff:since-tag -- <production-tag> --branch=<ref-about-to-ship>
   ```
   This writes `docs/change-summaries/<tag>-to-<branch>-<date>.md` with the commit log and
   changed-files stat. Read it.

3. **Group commits into feature areas.** Cluster the commits by what they actually change (e.g.
   "attendance history pages", "manual credit adjustment", "cancellation request workflow") rather
   than treating each commit as its own item. Ignore pure refactors/chores/fixes that don't change
   externally-observable behavior — this suite is black-box, so it only cares about what a real
   user or the API surface can see.

4. **Check existing coverage.** For each feature area, grep `src/integration/**` and `src/e2e/**`
   (the directory layout in [README.md](../../README.md) maps roughly to feature area — e.g.
   credits work lives under `src/integration/credits/`) to see if a test already exercises it. Only
   new or materially-changed behavior needs new tests — don't duplicate what's already covered.

5. **Draft test cases for the gaps.** For each uncovered feature area, write new test files
   following this repo's existing conventions:
   - Integration tests (`src/integration/<area>/*.test.ts`): real HTTP via
     `src/support/api-client.ts`, using `src/support/test-users.ts` / `fixtures.ts` for identities
     and org/centre setup. Never import the app's own source or touch its DB directly — black-box
     only, per the README's "Why black-box" section.
   - E2e tests (`src/e2e/<area>/*.spec.ts`): Playwright, real browser against `WEB_BASE_URL`,
     following the pattern in `src/e2e/auth/sign-in.spec.ts` / `src/e2e/client-portal/`.
   - Any test that mutates state must clean up after itself (matches every existing test in this
     suite — see README).
   - Prefer covering: the happy path, an authorization/cross-tenant check if the feature touches
     data scoped to an org/client (this suite's highest-value area per `docs/scenarios.md`), and
     one negative/edge case.
   - Before writing a lot of new tests speculatively, check in with the user on scope if the diff
     is large (many unrelated feature areas) — confirm priority rather than covering everything
     blindly.

6. **Verify the new tests compile.** Run `npm run typecheck` after adding files.

7. **Summarize phase 1** to the user before moving on: which feature areas got new tests, which
   were already covered, which were skipped and why (e.g. pure refactor, out of scope, needs their
   input).

## Phase 2 — full regression

1. **Determine the version label** for this regression run (distinct from the production tag in
   phase 1 — this is the label for the *new* run, e.g. `v1.2.0` or `pre-release-2026-09-25`). Ask
   if not given.

2. **Confirm the app instance is up.** This suite is black-box and talks to a live instance over
   HTTP — it does nothing useful if `movethemovementclan` isn't running. If unsure, check
   `API_BASE_URL`/`WEB_BASE_URL` in `.env` are reachable, or just try the run and watch for
   connection errors early. If it's not up, tell the user and stop rather than burning a run
   against nothing — see the README's Prerequisites section for how to start it.

3. **Run the regression**, now including whatever new tests phase 1 added:
   ```bash
   npm run regression -- <version>
   ```
   Pass through `--skip-integration` or `--skip-e2e` only if the user explicitly asked to run one
   suite only. Let it run to completion — the integration suite in particular can take a while
   under rate-limit backoff (`QA_AUTOWAIT_RATE_LIMIT=true`, up to ~70 min timeout).

4. **Report the result.** Read the run's `SUMMARY.md` and report to the user:
   - Overall pass/fail for each suite (counts for integration, exit code for e2e).
   - The path to the run folder and how to open the Playwright HTML report
     (`npx playwright show-report <path>/e2e/playwright-report`).
   - If there were failures: name the failing tests/areas, and point at
     `<run>/e2e/test-results/` for screenshots/traces of the failing e2e tests. Call out
     specifically if a failure is in one of the new tests from phase 1 (likely a real gap in the
     new feature) versus an existing test (possible regression elsewhere). Do not silently fix
     failing tests as part of this — surface them and let the user decide.

5. **Deploy gate.** Treat a clean run (both suites green) as the signal it's safe to proceed with
   deployment; treat any failure as a blocker to flag clearly, not something to wave through.
