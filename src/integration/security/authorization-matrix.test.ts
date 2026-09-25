import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createTenantOrg, getSeedCentre, getSeedCoachId, getSeedOrg } from "../../support/fixtures";
import { setActiveOrganization, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * Direct automation of security.html's SEC-API-01: "every procedure must have explicit
 * authentication, role, object, and centre-scope checks... route-policy inventory and automated
 * negative authorisation suite." One row per {no session / wrong role / tampered active-org}
 * against a representative sample of each procedure tier (clientProcedure, orgProcedure("admin")).
 */
describe("authorization matrix (docs/scenarios.md §2, §6)", () => {
  let owner: SignedInSession;
  let coach: SignedInSession; // org "member" role — below orgProcedure("admin")'s minimum
  let centreId: string;
  let coachId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    centreId = (await getSeedCentre()).id;
    coachId = await getSeedCoachId();
  }, 30_000);

  describe("no session at all -> 401", () => {
    const anon = newClient();
    const cases: Array<[string, () => Promise<{ status: number }>]> = [
      ["clients.me", () => anon.get("/clients/me")],
      ["credits.myBalances", () => anon.get("/credits/my-balances")],
      ["credits.grant", () => anon.post("/credits/grant", {})],
      ["classTemplates.list", () => anon.get("/class-templates")],
      ["bookings.list", () => anon.get("/bookings?filter=upcoming")],
      ["scheduling.materialise", () => anon.post("/scheduling/materialise")],
    ];
    for (const [name, call] of cases) {
      it(`${name} rejects an unauthenticated caller`, async () => {
        expect((await call()).status).toBe(401);
      });
    }
  });

  describe("garbage/malformed session cookie -> 401, not a 500", () => {
    it("a syntactically-invalid cookie value is rejected cleanly", async () => {
      const tampered = newClient();
      tampered.setCookie("better-auth.session_token", "not-a-real-token-at-all.garbage");
      const res = await tampered.get("/clients/me");
      expect(res.status).toBe(401);
    });
  });

  describe("right role, WRONG org (orgProcedure) -> 403, DB re-checks membership, not just session state", () => {
    it("an org-B admin fails orgProcedure('admin') checks that require org-A membership specifically", async () => {
      // credits.grant/classTemplates.* succeed for ANY org's admin against ANY target id (the
      // IDOR findings in cross-tenant-idor.test.ts) — but routes that DO check org membership
      // via `orgProcedure` role-rank still correctly require a `member` row for the ACTIVE org.
      // clients.enroll's centre-ownership check is the clean example: an org-B admin's own
      // active-org id is legitimately attached, but it doesn't match the seed centre's org.
      const { superadmin } = await createTenantOrg("authz-matrix-wrong-org");
      const res = await superadmin.client.post("/clients/enroll", {
        email: "authz-matrix-probe@move-qa.test",
        name: "probe",
        homeCentreId: centreId,
        coachId,
      });
      expect(res.status).toBe(404); // CentreNotFoundError — cross-org, same error as truly missing
    });
  });

  describe("right org, role below the minimum -> 403", () => {
    it("orgProcedure('admin') rejects a genuine 'member'-role caller in the RIGHT org", async () => {
      const res = await coach.client.post("/credits/grant", {
        clientId: "00000000-0000-4000-8000-000000000000",
        creditType: "SGPT",
        amount: 1,
        expiresAt: null,
        centreScope: null,
        reason: "should never reach the service layer",
      });
      expect(res.status).toBe(403);
    });

    it("clientProcedure rejects a valid session with no linked client profile (403, not 404 — ADR 0016)", async () => {
      const res = await owner.client.get("/clients/me");
      expect(res.status).toBe(403);
    });
  });

  describe("session state tamper: forcing activeOrganizationId via Better Auth's own endpoint (docs/scenarios.md §2.6)", () => {
    it("orgProcedure still re-verifies membership server-side even after set-active succeeds for a non-member org", async () => {
      const { organizationId } = await createTenantOrg("authz-matrix-set-active-tamper");
      // `coach` is genuinely NOT a member of this brand-new org at all.
      const setActiveRes = await setActiveOrganization(coach.client, organizationId).catch(
        (e: Error) => e,
      );
      // Whether Better Auth's own endpoint allows setting an arbitrary org id on the session or
      // rejects it outright, the ultimate test is what happens next:
      if (setActiveRes instanceof Error) {
        return; // set-active itself refused — the strongest possible outcome, nothing more to test
      }
      const res = await coach.client.post("/credits/grant", {
        clientId: "00000000-0000-4000-8000-000000000000",
        creditType: "SGPT",
        amount: 1,
        expiresAt: null,
        centreScope: null,
        reason: "should never reach the service layer — coach has no member row in this org",
      });
      // orgProcedure's identityService.resolveForUser re-queries the `member` table for this
      // exact org id on every request — session state alone must never be sufficient.
      expect(res.status).toBe(403);
    });
  });

  describe("superadmin bypass is real and org-independent (positive control — ADR 0006/0015)", () => {
    it("a superadmin with no member row anywhere in a brand-new org can still pass orgProcedure('admin')", async () => {
      const { superadmin, organizationId } = await createTenantOrg("authz-matrix-superadmin-bypass");
      const org = await getSeedOrg();
      expect(organizationId).not.toBe(org.id);
      // classTemplates.list has no per-org settings dependency, so a 200 here isolates the
      // authorization outcome specifically (scheduling.materialise, tried first, correctly 404s
      // downstream on this org's missing `materialisation_horizon_weeks` setting — a business-
      // logic 404, not an authorization failure; not what this positive control is testing).
      const res = await superadmin.client.get("/class-templates");
      expect(res.status).toBe(200);
    });
  });
});
