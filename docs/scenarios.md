# Threat model & test scenario catalog — movethemovementclan

*Living document, four audit rounds so far. Round 1 (2026-08-28, baseline `246b6bb`): §1.1–1.10,
§2.1–2.10, §3, §4, §7. Round 2 (2026-09-14, `develop` HEAD after 50 further commits): §1.11–1.17,
§2.11–2.12, §6a, §7.0 — re-auditing everything added since round 1 for the same bug classes. Round
3 (2026-09-15, after commits `8e024df`/`8243252`): re-attacked every round-1/2 finding against the
patched instance — **9 of 12 confirmed cross-tenant vulnerabilities are now fixed and
re-verified**; 2 P0s remain live (§1.13, §1.14). 56 automated checks total (52 integration + 4
e2e); as of round 3, 43 integration checks are green and 9 are red — the red ones are the
exploit-confirmation tests for now-fixed bugs, expected to fail until they're flipped to assert
the new secure (404) behavior (see the round-3 note under §1).*

*Round 4 (2026-09-19) — regression-suite hardening plus closing previously-catalogued ⬜ gaps,
not a fresh code audit. Three things surfaced: (1) **a real rate limiter now exists** —
`apps/api/src/middleware/rate-limit.ts` gates `/api/auth/sign-in` + `/api/auth/sign-up` at
5 requests/hour/IP (combined) and everything else at 100/min/IP — closing the §5 gap this catalog
previously documented as "not wired up." It's tight enough that this suite's own fixture pattern
(many fresh sign-ins/sign-ups) could no longer complete a run; see the harness-adaptation note at
the end of §5. (2) The §3.6 idempotency-key finding (`bookings.create` reuse with a different
`sessionId`) returned **409, not the previously-documented 200-with-stale-data**, in one non-rate-limited
run — likely fixed, not yet re-confirmed with a full clean run as of this writing. (3)
`staff@move.dev` failed a fixture sign-in with a genuine 401 (`INVALID_EMAIL_OR_PASSWORD`), not a
rate-limit error — unconfirmed whether this is a seed-data/password drift or a real regression;
flagged for the next full run to confirm before treating as a finding. New automated coverage this
round: §2.5, §3.2–3.4, §4.7, §7.14 (previously ⬜, cataloged since round 1 but never exercised
live).*

Black-box QA against a fitness-studio multi-tenant SaaS: orgs ("studios"), centres, coaches,
staff, clients, class templates → sessions, credit lots/ledger, bookings, cancellation policy.
Auth: Better Auth, JWT-in-httpOnly-cookie, two independent role axes — `user.role` (platform:
`user`/`superadmin`) and `member.role` (per-org: `member`/`admin`/`owner`).

This catalog is built from: the app's own architecture decisions (`documents/architecture/decisions/`),
its stated security requirements (`documents/internals/security.html`), its existing manual QA
docs/Postman collection (`documents/test/`), and direct code reading of every tRPC route,
procedure guard, and service in `packages/trpc` / `packages/services`. Status column: 🔴 confirmed
live against a running instance (an actual finding, not just a theoretical read of the code), 🟢
FIXED — vulnerability confirmed remediated and re-verified as of round 3 (2026-09-15), ✅
has a passing automated regression test in this repo, ⬜ scenario only — cataloged, not yet
automated (either not yet written, or not reachable black-box).

Legend: **P0** = exploitable now, no special access beyond "any org's admin"; **P1** = exploitable
given plausible additional conditions (UUID leak, multi-org account, timing); **P2** = hygiene /
defense-in-depth / requires infra access we can't reach black-box.

---

## 1. Cross-tenant broken object-level authorization (the headline finding)

The codebase has a real, followed convention for this exact problem — `identityProcedure`'s own
doc comment in `packages/trpc/server/trpc.ts` says it outright: *"there is no Postgres row-level
security wired up... treat any client id arriving via `.input()` as untrusted."* Routes like
`bookings.cancel`, `booking-oversight.*`, `schedule-exceptions.*`, `clients.enroll`, and
`clients.findByEmail` all follow it: they take the caller's `ctx.identity.organizationId` /
`ctx.client.id` and check it against the target row before acting, usually returning **404** (not
403) on a cross-org match so existence itself isn't leaked (see ADR 0016, ADR 0035).

Three route families are gated by `orgProcedure("admin")` (role-checked: caller must be an
admin/owner of *some* org) but then **never check that the target object belongs to that org**.
Any studio's admin account is sufficient — no special privilege, no guessing beyond a UUID.

| # | Scenario | Route | Status | Severity |
|---|---|---|---|---|
| 1.1 | Org-A admin reads Org-B client's credit balance | `credits.getBalances` | 🟢 FIXED 2026-09-15 (`8243252`), re-attacked today, now 404s | **P0** — financial PII cross-tenant read |
| 1.2 | Org-A admin grants free credits to an Org-B client, spendable at Org-B's centres | `credits.grant` | 🟢 FIXED 2026-09-15 (`8243252`) | **P0** — financial integrity, no audit trail links it to the right tenant |
| 1.3 | Org-A admin drains/zeroes an Org-B client's credit lot | `credits.reverse` | 🟢 FIXED 2026-09-15 (`8243252`) | **P0** — direct "delete someone else's money" |
| 1.4 | Org-A admin extends the expiry of an Org-B credit lot | `credits.extendExpiry` | 🟢 FIXED 2026-09-15 (`8243252`) | **P1** |
| 1.5 | Any org's admin lists **every** organization's class-template schedule — zero guessing, `list()` has no `WHERE` clause at all | `classTemplates.list` | 🟢 FIXED 2026-09-15 (`8243252`) — list is now org-scoped | **P0** — full cross-tenant enumeration, this is the finding that seeds 1.6/1.7's target ids |
| 1.6 | Org-A admin reschedules/recapacities/re-coaches an Org-B class template | `classTemplates.update` | 🟢 FIXED 2026-09-15 (`8243252`) | **P0** |
| 1.7 | Org-A admin creates a class template pointed at Org-B's `centreId`/`coachId` | `classTemplates.create` | 🟢 FIXED 2026-09-15 (`8243252`) — create now verifies centreId/coachId belong to caller's org; code + updated service-test verified, no dedicated live attack in this suite | **P1** |
| 1.8 | Any org's admin lists/updates all `sessionTypes` platform-wide (pricing, capacity, roster-privacy) | `sessionTypes.list`/`update` | 🟢 FIXED 2026-09-15 (`8e024df`+`8243252`) — same route as 1.15, now org-scoped | **P1** — table may be an intentionally shared catalog (no `organizationId` column); still, `creditCost`/`capacity`/`showRoster` are tenant-sensitive and any admin can silently change them for every studio |
| 1.9 | Chain: discover a foreign org's centre id via `organizations.listCentres` (only `protectedProcedure` — any authenticated user, any org), then self-enroll into it via `clients.join` | `organizations.listCentres` → `clients.join` | 🔴✅ partial — unchanged, not touched by the round-3 fix commits | **P1** — capped to one success per user by the `clients.userId` unique index (ADR 0032), but proves centre UUIDs function as an unauthenticated-strength invite code |
| 1.10 | Client books a session belonging to a different org's centre, if a foreign `sessionId` is ever obtainable | `bookings.create` | 🟢 FIXED 2026-09-15 (`8243252`) — client's home centre and the session's centre are now cross-checked before booking; the fix commit's own code comment cites this finding by number | **P2** — was an accepted-open gap in ADR 0035; the fix closes it at the code level even though it still isn't reachable black-box |

**Round 2 (2026-09-14) — the same bug class, unfixed and reproduced in fresh code.** A follow-up
audit of everything added to `packages/trpc/server/routes` / `packages/services` since the 1.1–1.10
findings above (50 commits, +12,058/-118 lines) found: the original `credits.*` bug was never
fixed, and the identical missing-org-check shape was written into brand-new code three more times.
Against that, the majority of genuinely new routers (`booking-oversight`, `billing`, `packages`,
`staff`, `attendance`, `schedule-exceptions`, updated `clients`) resolve the target's org (or the
new coach axis — see §10) via a repository lookup and 404/403 on a mismatch, the correct pattern —
this is a two-tier codebase where the mature pattern and the leftover baseline pattern coexist.

| # | Scenario | Route | Status | Severity |
|---|---|---|---|---|
| 1.11 | `credits.reverse` never validates lot ownership at all — not even via the `clientId` field it accepts: an unrelated org's admin drains a lot granted entirely by the real owner, spoofing an unrelated real client's id in the ledger | `credits.reverse` | 🟢 FIXED 2026-09-15 (`8243252`) | **P0** — also an audit-log-poisoning bug: the ledger records whichever `clientId` the caller supplies, independent of the lot's real owner |
| 1.12 | `credits.extendExpiry` has zero ownership check — doesn't even accept a `clientId` to cross-check against | `credits.extendExpiry` | 🟢 FIXED 2026-09-15 (`8243252`) | **P0** |
| 1.13 | New batched endpoint reproduces the exact `credits.getBalances` bug: an elevated caller (any org's admin) can read up to 100 clients' balances in one call, spanning any number of unrelated orgs | `credits.getBalancesForClients` | 🔴✅ **STILL LIVE** — re-attacked 2026-09-15, unchanged; not in scope of either round-3 fix commit or the team's own remediation-plan checklist | **P0** — introduced in fresh code one commit after the coach axis was correctly scoped on this same function; the org axis was never added |
| 1.14 | `coaches.list` has no filter of any kind (not even a broken one) — any org's admin sees every coach, at every studio, platform-wide | `coaches.list` | 🔴✅ **STILL LIVE** — re-attacked 2026-09-15, unchanged; no commit has touched `packages/services/coaches` or its route since round 2 | **P0** — zero setup needed beyond one unrelated org's admin session; also feeds `clients.enroll`'s/`reassignCoach`'s `coachId` pickers, so an attacker doesn't even need to guess ids |
| 1.15 | `sessionTypes.list`/`update` — upgraded from a read-only finding to a confirmed cross-tenant **write**: any org's admin can read AND silently rewrite (capacity, credit cost, roster visibility) a session type every other studio's class templates depend on, since `session_types` has no `organizationId` column at all by schema design | `sessionTypes.list` / `update` | 🟢 FIXED 2026-09-15 (`8e024df`+`8243252`) — session_types now has its own organizationId column | **P0** |
| 1.16 | Any authenticated user — no org membership required at all, `protectedProcedure` only — can read another studio's package catalog (names, pricing) by slug | `organizations.listPackages` | 🔴✅ unchanged — not touched by round-3 fix commits, still likely intentional | **P2** — likely intentional (backs the public `/join/[slug]` pre-signup browsing flow, same as the already-public `getBySlug`); flagged for team confirmation of intent rather than assumed to be a bug |
| 1.17 | Minor: `credits.getBalancesForClients` echoes back every requested `clientId` (including ones the coach-scoping restriction excluded, and even nonexistent ids) with an empty `balances: []`, rather than omitting excluded rows the way `clients.list`/`clients.search` do | `credits.getBalancesForClients` | 🔴✅ unchanged — not touched by round-3 fix commits | **P2 — informational, not a leak**: no real balance data escapes (see §10), and since *every* id is echoed unconditionally there's no existence-probing oracle either; still an inconsistency worth cleaning up |

**Round 3 (2026-09-15) — nine of twelve confirmed live vulnerabilities fixed, re-verified against
the running instance today.** Two commits landed today: `8e024df` (schema: `session_types` gets
its own `organizationId` column) and `8243252` ("fix: cross-tenant BOLA guards for credits,
class-templates, bookings, session-types"), evidently written directly against this catalog — the
booking fix's own code comment cites *"finding 1.10"* by number. Re-running this suite's
exploit-confirmation tests against the patched instance: §1.1–1.8 and §1.10–1.12, 1.15 all now
return 404 where they previously returned 200 — **every round-1 finding is fixed**, plus three of
round 2's six. **Two P0s remain genuinely open and unpatched: §1.13 (`credits.getBalancesForClients`)
and §1.14 (`coaches.list`)** — neither route was touched by either commit, and neither appears in
the team's own remediation-plan checklist (`.lavish/bola-remediation-plan.html` on the fix branch),
which explicitly scoped itself to §1.1–1.7 and §1.10. §1.16 and §1.17 are unchanged, as expected —
they were never exploit-confirmed bugs to begin with.

Two small things surfaced while verifying the fix, neither a new vulnerability: `credits.reverse`
against a non-existent `lotId` now returns **404** instead of the previously-documented 400
(§7.12) — the new org-ownership check runs before the amount-guard and correctly 404s on a lot it
can't find (matches the existence-hiding convention used everywhere else), but it means
`src/integration/credits/admin-credits.test.ts`'s "reversing a non-existent lot returns 400" test
is now itself stale and should be updated to expect 404. Separately, `credits/index.ts`'s
`getBalancesAsAdmin` still carries a doc comment reading `TODO(cross-tenant-bola): org-ownership
guard not yet implemented — see red tests` directly above the five lines that implement exactly
that guard — harmless, but worth deleting before it misleads someone into re-litigating a fixed
bug.

**Not automated from this round** (documented, not chased further): `credit-requests.create`
(`coachProcedure`, medium confidence) lets a coach file a `PENDING` credit request naming an
arbitrary `clientId` with no existence/ownership check at all — different shape than the rest
(no direct read/write leak; the risk is the spurious request silently surfacing, misattributed,
in a stranger org's owner's review queue) — skipped due to the fixture cost of a full
invite→accept→`coaches.completeProfile` chain for comparatively lower payoff. `sessions.getById`
(new route, `clientProcedure`) has no centre/org join at all in `findById` — high-confidence
cross-tenant read of full session detail (start/end time, coach, capacity) — but reproducing it
black-box needs a real second org with its own centre and materialized session, and there is no
API route to create a centre (seed-script/DB only) — not reachable through any other finding in
this suite, same category as §1.10.

**Reference pattern that should have been reused everywhere above:** `booking-oversight.listForClient`
takes the identical input shape (staff supplies a `clientId`) but calls
`repository.findClientOrganizationId(clientId)` and 404s on a mismatch before doing anything else.
`credits.*` is the same shape with that one check missing.

## 2. Authentication & session security

| # | Scenario | Status | Severity |
|---|---|---|---|
| 2.1 | Every protected route rejects a request with no session cookie at all | ✅ | P0 baseline |
| 2.2 | Every protected route rejects a request with a garbage/malformed cookie value | ✅ | P0 baseline |
| 2.3 | A `clientProcedure` route rejects a valid session that has no linked `clients` row (403, not 404 — ADR 0016) | ✅ | P1 |
| 2.4 | An `orgProcedure("admin")` route rejects a valid session whose org role is `member` (below the minimum) | ✅ | P0 |
| 2.5 | Cookie theft/replay: a session cookie exported from one client and imported into a second, unrelated HTTP client is accepted identically (expected — httpOnly cookies are bearer tokens over the wire; documents Better Auth's session model, not a bug, but confirms there's no IP/device binding) | ✅ `src/integration/security/session-cookie-replay.test.ts` (round 4) | P2 informational |
| 2.6 | `session.activeOrganizationId` tamper attempt: call Better Auth's own `/api/auth/organization/set-active` with an org the caller is **not** a member of, then hit an `orgProcedure` route — must still be rejected by the DB re-check inside `identityService.resolveForUser`, not merely by trusting session state | 🔴✅ | **P0** — this is the load-bearing test proving `orgProcedure` really re-verifies membership server-side rather than trusting whatever `set-active` accepted |
| 2.7 | 5-minute session/role staleness window (ADR 0008's `cookieCache`): demote or ban a user mid-session and confirm how long stale privileges survive | ⬜ | P1 — needs an admin-plugin ban/role-change call, timing-sensitive, documented here as a manual/scripted scenario rather than a fast CI test |
| 2.8 | Superadmin bypass works for an org the superadmin has no `member` row in at all (ADR 0006/0015) | ✅ | P1 — confirms the bypass is real (positive control) and doesn't also require a member row |
| 2.9 | Sign-in enumeration: does the error message differ for an existing vs. non-existent email? (`security.html` §4.1 requires uniform responses) | ✅ e2e (`src/e2e/auth/sign-in.spec.ts`) — checked at the web-UI layer, sign-in only; sign-up/reset-password not yet covered | P1 |
| 2.10 | Password policy: sign-up accepts/rejects short, common, breached-pattern passwords — client-side `min(8)` only per `documents/todo/auth-gaps.md`, no server-side breach screening | ⬜ | P2 — tracked gap, not a regression to chase, just confirm server-side minimum actually holds even if the client check is bypassed |
| 2.11 | **New (2026-09-14).** `ChangePasswordForm`'s `authClient.changePassword({ revokeOtherSessions: true })` — UI copy: "This signs you out of every other device" — does not immediately revoke a second live session. A concurrent session keeps full API access for up to ~5 minutes, matching `packages/auth/server/index.ts`'s `cookieCache: { maxAge: 5 * 60 }`, which the session middleware trusts over a DB re-check. Confirmed self-healing at +6min via a one-time manual diagnostic. | 🔴✅ (immediate-survival check); manual-only for the +6min self-heal confirmation | **P1** — bounded window, but it's exactly the threat model `revokeOtherSessions` exists to defend (a stolen/leaked session cookie); see `src/integration/security/session-revocation.test.ts` |
| 2.12 | **New (2026-09-14).** The "Your password was changed" confirmation email (commit 5764c7e) never actually sends — reproduced via both the real web UI and a direct API call, ruling out a frontend-specific or environment/SMTP cause (the sign-up verification email for the same address arrives fine seconds earlier). Likely cause: `send-password-changed-email.ts`'s hook only fires when the `account` object passed to `databaseHooks.account.update.before` carries a `userId` field alongside `password` — if Better Auth's hook actually receives only the changed-field delta (not the full row), `userId` would be `undefined` and the function silently no-ops. QA-side hypothesis for engineering to confirm, not an asserted root cause. | 🔴✅ | **P1** — functional regression on a stated security-notification feature (security.html §10 wants users to hear about account-security events); no PII/credential leak by itself |

## 3. Input validation / injection / mass assignment

| # | Scenario | Status | Severity |
|---|---|---|---|
| 3.1 | Non-UUID `sessionId`/`clientId`/`lotId` etc. rejected with 400 before any DB round-trip (zod `.uuid()` on every route reviewed) | ✅ | P1 baseline |
| 3.2 | SQL-injection-shaped strings in every free-text field (`reason`, `name`, `email`) come back inert — Drizzle is fully parameterized, but confirm no raw-SQL code path exists on the reachable surface | ✅ `src/integration/security/injection-and-mass-assignment.test.ts` (round 4) — confirmed inert against `credits.grant`'s `reason` field | P1 |
| 3.3 | XSS payload (`<script>`, `<img onerror>`) in `reason`/`name` fields is stored and returned verbatim over the API (expected — API layer isn't responsible for output encoding) but flagged for the web app's rendering layer, since these fields surface in staff-facing tables | ✅ `src/integration/security/injection-and-mass-assignment.test.ts` (round 4) — API-side proof only, front-end encoding still not exercised by this suite | P2 — API-side proof only would be needed; front-end encoding not exercised by this suite |
| 3.4 | Mass assignment: attempt to smuggle `role`, `status`, `organizationId`, `id`, `balanceAfter`, `remaining` into `credits.grant`/`classTemplates.update`/`clients.enroll` bodies and confirm the extra fields are silently dropped (zod schemas are allow-lists, not `.passthrough()`) | ✅ `src/integration/security/injection-and-mass-assignment.test.ts` (round 4) — confirmed against `credits.grant` and `clients.enroll`; `classTemplates.update` not yet covered | P1 — no gap found in code reading; worth a regression test since a future schema edit could reintroduce one |
| 3.5 | Negative amounts / zero / overflow in `credits.grant.amount`, `credits.reverse.amount` — zod `.int().positive()` should reject, confirm live | ✅ | P1 |
| 3.6 | Idempotency-key reuse with **different** parameters on `bookings.create` — the key is scoped per the ADR 0025 three-layer design; confirm reuse with a different `sessionId` doesn't silently return the *old* booking as if it matched | ✅🔴 | **P1 — live-verified finding**: reuse with a different `sessionId` returns HTTP 200 with the *original* booking's `sessionId`, not an error and not the new session. security.html §7 requires keys to be "bound to ... request parameters" and reuse with different parameters to be rejected; this server keys purely off the idempotency string. See `src/integration/bookings/happy-path.test.ts`. |

## 4. Race conditions / financial integrity (ADRs 0018, 0020, 0021, 0025, 0027)

| # | Scenario | Status | Severity |
|---|---|---|---|
| 4.1 | Fire the identical `bookings.create` request (same idempotency key) twice, concurrently — must converge on exactly one booking, not two | ✅🔴 live-verified, `src/integration/bookings/concurrency.test.ts` | P0 |
| 4.2 | Fire two DIFFERENT booking requests for the same client against the same session, concurrently — exactly one must win (409 `OverlappingBookingError` for the other), proving the client-row lock (ADR 0021) actually serializes a client's own concurrent attempts | ✅🔴 live-verified | P0 |
| 4.3 | Two different clients race for the last seat on a `capacity: 1` session — exactly one must win, the other gets `SessionFullError` (409), not a phantom overbook | ✅🔴 live-verified | P0 |
| 4.4 | A client with exactly 1 remaining credit fires two different booking requests concurrently (different sessions) — exactly one must succeed, the credit-lot guarded decrement (ADR 0020) must stop the other, never both | ⬜ — the general mechanism is exercised as a side effect of 4.3, but the specific "last-credit, not last-seat" race isn't isolated as its own test | P0 |
| 4.5 | Cancel a booking before the 4h window and confirm the credit is refunded | ✅ — confirmed as part of the happy-path test | P1 functional |
| 4.6 | Cancel a booking inside the 4h window and confirm NO refund (`CANCELLED_LATE`) | ⬜ — needs a session known to be <4h out; none of the seed data's materialized sessions land in that window | P1 functional |
| 4.7 | Cancel the same booking twice — second call is rejected, not a double refund | ✅ `src/integration/bookings/cancellation-edge-cases.test.ts` (round 4) | P1 |
| 4.8 | Cancel someone else's booking (bookingId belongs to a different client) — 404, not 403 (ADR: "wrong owner looks the same as not found") | ⬜ — reasoned correct from the code (`repository.lockBookingForCancellation` scopes by both bookingId AND clientId), not yet exercised live | P0 |
| 4.9 | Admin `booking-oversight.move` inside the client's cancellation window still forfeits a credit per ADR 0039's accepted policy (2-credit cost for a staff-initiated move within the window) — functional confirmation, not a bug hunt | ⬜ | P2 |
| 4.10 | One client books the same session twice with **different** idempotency keys (a genuine duplicate, not a retry) — must be rejected (409 `OverlappingBookingError`, since a session always overlaps itself) and leave `bookedCount` at 1. Also asserted with three such requests fired concurrently | ✅🔴 live-verified, `src/integration/bookings/capacity.test.ts` | P0 |
| 4.11 | Capacity is a hard ceiling, sequentially and concurrently: the (capacity+1)-th booking is refused with `SessionFullError` (409), and with 10 clients racing for K seats **exactly** min(10, K) win — never more (oversell) and never fewer (seats lost to lock contention) | ✅ live-verified up to 8 concurrent clients; blocked at 10 by 4.12 | P0 |
| 4.12 | **🔴 FINDING — concurrent bookings deadlock the entire API.** `CreditBasedChargeStrategy.chargeFor` (`packages/services/bookings/charge-strategy.ts:30`) calls `credits.pickCreditLot(...)` from *inside* the booking transaction, but `pickCreditLot` takes no `tx` parameter at all (`packages/services/credits/index.ts:91`) — it is documented as a "pure decision" and so queries the pooled global `db`; the very next call, `reserveCreditLot(tx, ...)`, does take the transaction. A booking that already holds the `sessions` row lock (`FOR UPDATE`) must therefore borrow a *second* pool connection to finish. Once concurrent bookings reach the `pg` pool size (drizzle `node-postgres` default `max: 10`), every connection is held by a transaction that cannot progress without a connection that no longer exists. **Deadlock is permanent** — no statement timeout, no recovery; every database-backed route hangs until the API process is restarted | ✅🔴 live-verified, `src/integration/bookings/capacity.test.ts` | **P0 — self-inflicted DoS: 10 concurrent bookings of one session take the whole API down** |

### 4.12 — reproduction and evidence

> Full write-up with the fix, ready to hand to a developer: [`docs/findings/4.12-booking-connection-pool-deadlock.md`](findings/4.12-booking-connection-pool-deadlock.md)

Ten signed-in clients `POST /api/bookings` for one session simultaneously. No response ever
returns. `/health` (which touches no database) still answers in <1ms, while every DB-backed route
times out — the giveaway that this is pool starvation rather than a crashed process.

`pg_stat_activity` on the seed database during the wedge:

```
        state        | wait_event_type |  wait_event   | n | longest_in_state
---------------------+-----------------+---------------+---+------------------
 active              | Lock            | tuple         | 8 | 00:11:45
 active              | Lock            | transactionid | 1 | 00:11:45
 idle in transaction | Client          | ClientRead    | 1 | 00:11:45
```

The single `idle in transaction` backend's last statement is
`insert into "bookings" ... on conflict ("idempotency_key") ...` — i.e. it got as far as the
insert, still holds the session row lock, and then Postgres stopped hearing from the application
(`ClientRead`), because the application is itself blocked waiting for a pool connection that the
other nine transactions are holding. The other nine are all parked on
`select ... from "sessions" ... for update`, behind that first one. Nothing times out; it sat in
this state indefinitely until the API was restarted.

Note the existing comment at `packages/services/credits/index.ts:122-125` — "`pickCreditLot` reads
outside any lock, so the picked lot may have been spent by a concurrent booking" — shows the
*correctness* consequence of reading outside the transaction was known and deliberately handled
(the guarded UPDATE in `reserveCreditLot`, ADR 0020). The **liveness** consequence is the part
that was missed: reading outside the transaction also means needing a second connection while
holding one, which is the classic recipe for pool-starvation deadlock.

Suggested fix: give `pickCreditLot` a `tx` parameter and pass the booking's transaction through,
so the whole charge runs on one connection. As defence in depth, setting `statement_timeout` and
`idle_in_transaction_session_timeout` on the pool would convert any future instance of this class
of bug from a permanent outage into slow failing requests, and raising `max` would only move the
cliff, not remove it.

## 5. Rate limiting / resource exhaustion

`apps/api/src/middleware/rate-limit.ts` now implements `security.html` §5.1's baselines:
`generalRateLimit` (100 req/min) on `/api` and `/trpc`, and `authRateLimit` (5 req/hr) narrowed to
`/api/auth/sign-in` and `/api/auth/sign-up`. Both are keyed by `req.ip`. (This section previously
recorded that no limiter existed at all — it does now.)

| # | Scenario | Status | Severity |
|---|---|---|---|
| 5.1 | Burst N `bookings.create` calls in a short window from one client, past the documented 20/min/user booking baseline — the general 100/min/IP limiter is the only thing in front of it, so a per-user booking cap is still unenforced | ⬜ | P1 |
| 5.2 | Burst `credits.grant`/`classTemplates.create` calls from one admin — same | ⬜ | P1 |
| 5.3 | Credential-stuffing burst against `/api/auth/sign-in/email` | ✅ confirmed live: the 6th sign-in attempt within an hour returns 429 with `Retry-After` | P1 |
| 5.4 | **🔴 FINDING — the rate-limit bucket is caller-selectable when the API is reachable directly.** `apps/api/src/server.ts:16` sets `app.set("trust proxy", 1)`, so `req.ip` is taken from `X-Forwarded-For`. That is correct behind exactly one reverse proxy, but if the API is ever reachable without that proxy in front, a caller picks its own bucket by forging the header and the 5/hr auth limit stops constraining anything — verified live: 5 attempts from one forged IP return 429, and changing a single octet resets the budget to full | ✅🔴 live-verified (this suite depends on it to provision fixtures — see `src/support/client-pool.ts`) | P1 — the control is only as strong as the network guarantee that a real proxy always terminates first; worth an explicit deployment assertion |

## 6. Authorization matrix (systematic, per-route)

Automated as a single parametrized suite rather than one scenario per row: for every
`orgProcedure`/`clientProcedure` route reviewed, assert the full {no session, wrong role, right
role wrong org, right role right org} grid returns the expected status. This is the direct
automation of `security.html`'s SEC-API-01 ("every procedure must have explicit authentication,
role, object, and centre-scope checks... route-policy inventory and automated negative
authorisation suite").

## 6a. Coach-scoping (new access axis, since 2026-09-11) — positive control

`f59e0ac`/`223f628` added a third identity axis alongside client/org-role: a **coach**, resolved
server-side from the session (`ctx.coach`, never trusted from input — see `coachProcedure`/
`adminOrCoachProcedure` in `packages/trpc/server/trpc.ts`) and scoped to only their own assigned
clients/sessions. Unlike §1's findings, this mechanism is *mostly* correctly enforced — this
section actually exercises it with a real "a colleague's client, same org" case (constructing a
genuine second coach via the invite→`coaches.completeProfile` flow, since the seed org's only
centre has exactly one pre-existing coach and every self-joined client auto-assigns to them —
an "unassigned" client isn't a valid test case here at all) rather than trusting the code read.

| # | Scenario | Status | Result |
|---|---|---|---|
| 6a.1 | `clients.list` — a coach sees their own assigned client, not a colleague's | ✅ | **Correctly scoped** |
| 6a.2 | `credits.getBalancesForClients` — a coach cannot read a colleague's client's actual balance data | ✅ | **Correctly scoped** — see §1.17 for the harmless id-echo quirk found alongside this |
| 6a.3 | An owner (elevated) sees both clients — confirms the restriction is coach-specific, not a general filter bug | ✅ | **Correct** (positive control on the positive control) |
| 6a.4 | `attendance.mark`/`roster` reject a coach acting on a session they aren't assigned to (`NotAssignedToSessionError`) | 🔴 code-confirmed only — not yet exercised live | Reasoned correct from `packages/services/attendance/index.ts`'s `findSessionCoach` check |

See `src/integration/security/coach-scoping.test.ts`.

## 7. Business-logic / functional edge cases (from the existing manual QA docs, now automated)

Mirrors and extends `documents/test/move-api.postman_collection.json` and
`documents/test/booking-qa-manual.html` / `auth-qa-manual.html`. One correction along the way:
**the checked-in Postman collection's REST URLs are missing the `/api` prefix** (e.g. it calls
`{{baseUrl}}/bookings` where the live server only mounts the REST surface under
`{{baseUrl}}/api/bookings` — confirmed against `apps/api/src/server.ts`'s
`app.use("/api", createOpenApiExpressMiddleware(...))`). Every request in that collection as
currently checked in would 404. This suite uses the correct `/api` prefix throughout.

| # | Scenario | Status |
|---|---|---|
| 7.0 | **Changed (2026-09-07).** `clients.enroll`'s `coachId` field became required ("staff-add always requires an owner-picked coach") — every enroll fixture in this suite now resolves the seed coach id first (`getSeedCoachId()`) and passes it; `clients.join`'s self-service path stayed coach-optional (auto-assigns via `resolveCoachForCentre`) | ✅ |
| 7.1 | Enroll a new client by email as org admin — happy path | ✅ |
| 7.2 | Enroll as a non-admin (coach) — forbidden | ✅ |
| 7.3 | Enroll into a centre from outside the org — rejected as "centre not found" (anti-enumeration: same error as a genuinely bad id) | ✅ |
| 7.4 | Self-service join when already enrolled — conflict, not a duplicate row | ✅ |
| 7.5 | Enroll with no session at all — 401 | ✅ |
| 7.6 | Book a session, happy path; idempotent retry returns the same booking | ✅ |
| 7.7 | Book with zero credits — `InsufficientCreditsError` | ⬜ — needs a client fixture drained to exactly zero for a credit type; not yet set up | P1 |
| 7.8 | Book a session that doesn't exist / malformed id / no session at all | ✅ |
| 7.9 | Book while signed in but with no client profile (e.g. a coach account) — 403 | ✅ |
| 7.10 | Book an already-started session — rejected | ⬜ — the app's own manual QA fixtures note this needs a session backdated directly in the DB; not reachable black-box, matches the original Postman collection's own admission of the same gap |
| 7.11 | Grant credits as admin; grant as non-admin — forbidden | ✅ |
| 7.12 | Reverse more than the current balance — rejected, balance unchanged | ✅🔴 finding: HTTP 400, not 422 — see below |
| 7.13 | Reverse a valid amount; extend a lot's expiry | ✅ |
| 7.14 | Materialise sessions as admin; as non-admin — forbidden | ✅ `src/integration/scheduling/materialise-authz.test.ts` (round 4) | P2 |

## 8. Additional findings surfaced while automating (not predicted by code reading alone)

Everything above was written from reading the source first, then verified live. These two only
surfaced once the automated suite actually ran repeatedly against the live instance:

- **`InsufficientCreditsError` is declared as HTTP 422 in `packages/services/credits/error.ts`
  (and documented as 422 in `documents/architecture/booking.md`'s error table) but is never
  actually 422 over the wire.** `packages/trpc/server/utils/http-status.ts`'s
  `HTTP_STATUS_TO_TRPC_CODE` map has no tRPC error code for 422 (tRPC's `TRPCError` only supports
  its fixed standard-code enum) and falls back to `"BAD_REQUEST"`, which the OpenAPI adapter then
  serializes as HTTP 400. A client cannot distinguish "insufficient credits" from a generic
  validation error by status code alone — only the response body's `message` string differs.
  Same root cause affects any other `ServiceError` subclass declared with a status this map
  doesn't carry a 1:1 entry for. P2 — API-contract inconsistency, not a security issue.
- **`bookings.create`'s handler calls `TRPCResponse.created()` (message: "Booking created") but
  the HTTP status is 200, not 201.** `trpc-to-openapi` doesn't infer 201 from a mutation by
  itself; nothing in the route's `.meta()` sets it explicitly. Cosmetic, but means the message
  string and the status code disagree about whether this was a creation.

## 9. What this suite deliberately does not attempt

- **Infrastructure-layer requirements** (SEC-DATA-*, SEC-INFRA-*, SEC-OPS-*, SEC-SDLC-*) — no
  AWS/S3/CloudWatch/CI access from a black-box HTTP/browser vantage point.
- **Rate-limit enforcement tests (§5)** — there is currently nothing to assert *against*; a burst
  test today would only prove "still unlimited," which is already known from reading
  `apps/api/src/server.ts`. Worth adding the moment a limiter is introduced, as a regression
  tripwire on the documented baselines.
- **The 5-minute session-cache staleness window (§2.7)** — requires an admin-plugin ban/role-change
  call plus a real wall-clock wait; not suited to a fast CI-run suite. Documented as a scripted
  manual scenario, not automated here.
- **`bookings.create` with a genuinely foreign-org `sessionId` (§1.10)** — was ADR 0035's own
  acknowledged open gap, and still not reachable black-box (no route exists to obtain a foreign
  org's `sessionId`). **Fixed anyway as of 2026-09-15**: `bookings.create` now cross-checks the
  client's home centre and the session's centre resolve to the same org before booking, closing
  the gap at the code level even without a black-box way to attack it.
- **`sessions.getById` with a foreign-org `sessionId` (§1's round-2 addendum)** — same shape as
  §1.10, new route, same reason it's not reachable: no black-box way to obtain a second org's
  `sessionId` without a route to create a centre in that org.
- **`credit-requests.create` naming an arbitrary cross-org `clientId` (§1's round-2 addendum)** —
  real, code-confirmed gap, skipped for now due to the fixture cost (a full invite→accept→
  `coaches.completeProfile` chain, the same one built for §6a) relative to its lower-severity,
  different-shape payoff (a misattributed pending request, not a direct read/write leak).
- **The +6 minute self-heal confirmation for §2.11's session-revocation window** — characterized
  once via a manual diagnostic (a 6-minute wait), not kept as a standing automated test; the fast,
  permanent regression check only asserts the *immediate* non-revocation.

---

## How this maps to the app's own stated requirements

`documents/internals/security.html` §14 defines testable requirements this suite directly targets:

- **SEC-AUTH-01/02** — §2 (session validation, role-from-DB-not-input), including the §2.11
  session-revocation-delay and §2.12 confirmation-email findings added 2026-09-14.
- **SEC-API-01** — §1, §6, and §6a (object/centre/coach-scope checks). Nine of the twelve
  confirmed P0/P1 cross-tenant findings are now fixed and re-verified (round 3, 2026-09-15); two
  P0s remain open — `coaches.list` (§1.14) and `credits.getBalancesForClients` (§1.13).
- **SEC-API-02** — §3 (Zod coverage / malformed-input tests).
- **SEC-INT-01** — §4 (atomic/idempotent/audited financial operations).

SEC-DATA-*, SEC-INFRA-*, SEC-OPS-*, SEC-SDLC-* are infrastructure/ops-layer requirements this
black-box suite cannot exercise (no AWS/S3/CloudWatch/CI access) — out of scope here by design,
not overlooked.

## 11. Gaps in this QA effort — a self-assessment

Everything above is a gap in the *app*. This is the other direction: where this *suite itself* is
thin. Ranked by risk, not by effort to fix.

**11.1 — Money-handling routes with zero functional test coverage.** The round-2 audit only asked
one question of the new routers — does the cross-tenant bug repeat here? For the ones that came
back clean, that's the *only* thing tested; nobody has run their actual happy path.

- `billing.createManualSale`/`fulfillPurchaseRequest`/`requestRenewal` — records real payments,
  grants real credits, never called by this suite, only read. **High risk.**
- `packages.create`/`update`/`listActive` — defines what's purchasable and at what price. **High.**
- `credit-requests.create`/`approve`/`reject`/`listPending` — the whole coach→owner approval
  workflow, no test at all. **High.**
- `clients.reassignCoach` — flagged by the round-2 research as having no repository-layer
  defense-in-depth (relies entirely on service-layer check ordering); no regression test watches it. **Medium.**
- `attendance.mark`/`roster` — coach-ownership check is code-confirmed only (§6a.4). **Medium.**
- `organizations.invite` (real email)/`organizations.create` — only ever used as fixture-building
  shortcuts via Better Auth's raw primitives; the app's own business-role invite path and
  superadmin-onboarding guard are never directly asserted against. **Medium.**
- `staff.completeProfile`, `admin-dashboard.stats`, `credits.myActivePackages`/`listExpiringSoon`,
  `clients.search`, `scheduling.mySchedule` — no route-specific test. **Low.**

**11.2 — A full second portal shipped; one browser test exists.** `apps/web/app/admin/*` is an
entire admin portal (dashboard, bookings, clients, credits, invites, packages, payments, schedule,
session-types, team), and staff/client portals both grew substantially too. This suite has exactly
one Playwright spec outside auth (`change-password.spec.ts`). Untested: the entire `/admin/*`
portal (manual-sale-dialog, package-form-dialog, payments/schedule/session-type views, invites-view);
`staff/my-schedule` and `staff/clients`; `client/packages` and `client/sessions/[sessionId]`; and
every non-sign-in auth/onboarding page (`/join/[slug]`, `/accept-invitation/[id]`,
`/forgot-password`, `/reset-password`, `/sign-up`).

**11.3 — Test types never attempted, not just deferred.**

- Injection/XSS/mass-assignment payloads (§3.2–3.4) — still reasoned-safe-from-code-reading only.
  Cheap to close; should be first, not last.
- CORS/Origin enforcement — this suite's own `ApiClient` always sends a legitimate `Origin` header;
  nothing tries a *disallowed* origin to confirm the allowlist actually rejects it.
- Contract/schema drift against the live OpenAPI spec (`/openapi.json`) — would have caught the §8
  422→400 and 200→201 mismatches structurally instead of by accident.
- Accessibility — a real design system exists; zero automated a11y checks on any page.
- Visual regression, cross-browser (Playwright is chromium-only), mobile viewport, load/perf beyond
  2–3-way concurrency races — none attempted.

**11.4 — Process gaps that will bite before any of the above does.**

- No CI wiring at all — this suite has only ever run manually against one long-lived local Postgres;
  never proven to pass from a clean checkout.
- No test-data isolation or teardown — every run leaves throwaway orgs/users/credit lots in the
  same database permanently; no ephemeral-DB-per-run.
- Shared mutable seed accounts, no reset — a genuinely broken test could leave state that fails an
  unrelated later one.
- No coverage inventory — this document lists scenarios that exist; never checked against a literal
  enumeration of every tRPC procedure to confirm nothing shipped with zero test touching it at all.
