# Member lifecycle (pause / archive) — QA coverage

Branch under test: `feature/coach-client-profile-crud` (app repo).
Scenario source: `movethemovementclan/documents/test/member-lifecycle-e2e.md`.
Tests: `src/integration/member-lifecycle/` (58 tests, API-level, black-box).

Every test builds its own throwaway clients / coaches / weekly classes and winds them down in
`afterAll` (`LifecycleCleanup` in `src/support/lifecycle.ts`). Seed identities are only ever read.

## What is covered

| File | Scenarios |
| --- | --- |
| `lifecycle-authz.test.ts` | P-02..P-06, P-12, P-13, CP-36, X-01, X-02, CP-35, CR-11, CA-12, CHR-07 |
| `client-pause-resume.test.ts` | CP-01..04, CP-08..10, CP-20..21, CP-24, CP-30..34, CP-37..38, CP-51/52, CR-01..04, CR-06, CR-09/10, B-01, B-04, B-13, A-09, SP-01/05/06/08 |
| `client-archive-restore.test.ts` | CA-01..03, CA-06..09, CA-11, CA-14/17, CA-16, RC-01..03, RC-06..09, RC-12/13, L-12/13, A-04/05 |
| `coach-archive-restore.test.ts` | CH-01, CH-08/09, CH-20..24, CH-29/30, CH-34, CH-48/49, CHR-01/02/06/09, L-03, L-07/08, S-05/06 |
| `coach-archive-sessions.test.ts` | CH-02, CH-05, CH-44 (real session hand-over / cancel — plan gap G-14) |
| `lifecycle-regression.test.ts` | R-01, R-03, R-08, R-13, B-10, L-10, UC-02/04, CRD-22/24, PO-64/66, G-07, D-01 |

## Not covered here (needs UI, DB access, email inspection or time travel)

Wizard / dialog behaviour (CW-*, CAW-*, CHW-*, UC-09..13, UH-*, PO-60.. banners), exact expiry maths
over days (CR-03, SP-09), scheduled→in-effect transition (SP-07), emails other than "no password
reset to archived users" (§14), renewal-reminder job (CRD-28), audit-log rows (§19), migration
checks (§1), second-org-with-clients cross-tenant cases beyond the 404 checks above.

## Findings

1. **BUG — concurrent pauses both succeed (CP-51 / CP-52).** `client-pause-resume.test.ts`
   "two simultaneous pauses" fails: two parallel `pause-client` calls both return 200.
   `MemberLifecycleService.pauseClient` checks `client.status === "ACTIVE"` before opening the
   transaction and `setClientStatus` updates unconditionally (no row lock / `WHERE status='ACTIVE'`),
   so both commit (duplicate `CLIENT_PAUSED` audit rows; with bookings, a double cancel/refund
   attempt). Fix: lock the client row inside the unit of work and re-check the status there.
   Same pattern probably applies to resume/archive/restore.
2. **Plan inconsistency — CR-06 vs SP-09.** CR-06 says resuming seconds after pausing extends
   expiry by ≈ 0. Pausing "from today" actually holds from IST midnight of that day, so a pause made
   at 17:30 IST extends the lot by ≈ 17.5 h. Matches SP-09, contradicts CR-06 — update the plan.
3. **Throwaway coaches consume org seats.** Archiving a coach does not free its org membership;
   Better Auth caps an org at 100 members. The suite now re-leases archived `lc-*` coaches instead
   of minting new ones (membership count stays flat across runs). The seed org is currently at 100.
4. `client3@move.dev` (the plan's "control" client) is **ARCHIVED and banned** in the dev DB —
   not by this suite (it only reads seed users). It makes `credit-types-lifecycle` F2 fail on sign-in.
   Restore it (or reseed) before a regression run.

## Impact on existing suites (run against this branch)

With a clean `.qa-cache` the existing suite has 13 failures; none trace to lifecycle code:

- 9 × `security/cross-tenant-idor*.test.ts` — these assert the *old* vulnerability (200);
  the API now returns 404, i.e. the BOLA fix is live. Tests are stale, not the app.
- `session-cookie-replay` — `get-session` with a garbage cookie returns a null body, test expects `{user:null}`.
- `happy-path` idempotency conflict — error envelope carries `data.code`; test expects `data` undefined.
- `cancellation-edge-cases`, `concurrency`, `capacity` — shared-state noise: per-client booking
  limiter (20/min) tripped by repeat runs, overlapping duplicate sessions at the same time slot,
  capacity-1 slots already taken.
- `credit-types-lifecycle` F2 — `client3@` archived (finding 4).

Not verified against a `develop` baseline (would need a second API instance); the attribution above
is from reading each failure, so treat the bookings group as "likely environmental".

A stale cached coach session (no active organisation) also produced 12 spurious 400s in one run;
deleting `.qa-cache/seed-sessions.json` cleared it. Cause not established.
