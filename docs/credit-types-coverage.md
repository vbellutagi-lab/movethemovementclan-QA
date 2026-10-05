# feature/credit-types — checklist → automated coverage

Source: `.lavish/credit-types-manual-test-checklist.md` in the app repo. Run with
`npx vitest run src/integration/credit-types` and `npx playwright test src/e2e/credit-types`.
All specs create their own uniquely-coded credit types / throwaway clients and retire them
afterwards (credit types and session types have no delete endpoint, so they are left *inactive*).

| Checklist | Automated in |
|---|---|
| A1–A3 tabs, list, no Inactive badge | e2e `credit-types-admin` |
| A4, A5, U1–U9, U11 portal guard | e2e `portal-access-guard` |
| A2, B1–B6, B8, C1, C3 create/edit via API | integration `credit-types-crud`, `credit-types-authz` (B8) |
| B2–B7, C1, C3, C4 create/edit dialogs | e2e `credit-types-admin` |
| R1, R3, U12 permissions + tenant isolation | integration `credit-types-authz` |
| D10 client reads `creditTypes.list` (200) | e2e `client-credit-types`, integration `credit-types-authz` |
| E1, E5, J10d inactive-type grant refused | integration `credit-types-lifecycle` |
| F2 (finding), F4, F5 coach requests | integration `credit-types-lifecycle` |
| G4–G7, G9, O1 session-type Active flag | e2e `session-type-active` |
| H5a–H5d, J7 package grant lock / replace | integration `credit-types-lifecycle` |
| I1, I4–I6, I8, I9 deactivate dialog | e2e `credit-types-admin` |
| I2–I4, I7, I9, I10, J2, J3, J5, J6, K1–K3, K6, L1, L2, L5 | integration `credit-types-lifecycle` |
| M7, M9 (partly), M11 frozen client view | e2e `client-credit-types` |

**Finding:** F2 — `creditRequests.create` has no coach-ownership check; coach 1 can file a request for
coach 2's client. The UI hides it; the API does not. The test asserts today's behavior
(200) and should be flipped to expect 403/404 once the server enforces it.

**Not automated yet** (needs seeded sessions/DB access, or is visual): D1–D9 picker colours, D7, E4, J1/J4 wording,
J14/K4/K5/L5 audit-log rows, M1–M6 owner chips, M10 calendar, N, O2–O9 (booking/materialiser), P, Q,
S (mobile/theme/slow network), T (SQL checks). Suggested next: P/Q booking + billing regressions and O2–O4.
