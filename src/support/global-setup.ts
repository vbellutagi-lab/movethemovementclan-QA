import { env } from "./env";
import { newClient } from "./api-client";
import { signInAs, setActiveOrganization } from "./test-users";

/**
 * Fails the whole run fast with a clear message instead of 30 confusing ECONNREFUSED
 * failures scattered across every test file, if nothing is listening on API_BASE_URL.
 *
 * Also re-runs session materialisation before every run. `sessions` rows are wall-clock
 * dependent (ADR — SchedulingService.materialiseSessions expands class_templates out to a
 * per-org horizon from "now") — a suite run days after the last materialise finds zero
 * bookable sessions for the seed client's home centre otherwise, which is exactly what broke
 * this suite after the DB sat untouched for a couple of weeks. Idempotent (materialise only
 * inserts missing (templateId, startsAt) pairs), so safe to call on every run.
 */
export default async function globalSetup() {
  try {
    const res = await fetch(`${env.apiBaseUrl}/health`);
    if (!res.ok) throw new Error(`/health returned HTTP ${res.status}`);
  } catch (error) {
    throw new Error(
      `movethemovementclan API is not reachable at ${env.apiBaseUrl}. Start it first ` +
        `(docker compose up -d && pnpm dev in the app repo) and run its seed script ` +
        `(pnpm db:seed from apps/api) before running this suite.\nCause: ${String(error)}`,
    );
  }

  try {
    const anon = newClient();
    const orgRes = await anon.get<{ data: { id: string; slug: string } | null }>(
      `/organizations/${env.seedOrgSlug}`,
    );
    if (orgRes.status !== 200 || !orgRes.body?.data) {
      throw new Error(`GET /organizations/${env.seedOrgSlug} failed: HTTP ${orgRes.status}`);
    }
    const { client } = await signInAs("owner");
    await setActiveOrganization(client, orgRes.body.data.id);
    const materialiseRes = await client.post("/scheduling/materialise", {});
    if (materialiseRes.status !== 200) {
      throw new Error(`POST /scheduling/materialise failed: HTTP ${materialiseRes.status}`);
    }
  } catch (error) {
    throw new Error(
      `Global setup could not re-materialise sessions for the seed org — is the DB seeded ` +
        `(pnpm db:seed from apps/api)?\nCause: ${String(error)}`,
    );
  }
}
