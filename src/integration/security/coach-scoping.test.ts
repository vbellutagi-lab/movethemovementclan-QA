import { beforeAll, describe, expect, it } from "vitest";
import {
  createSecondSeedOrgCoach,
  getSeedCentre,
  getSeedCoachId,
} from "../../support/fixtures";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";
import { uniqueEmail } from "../../support/random";

/**
 * Positive control for the new `adminOrCoachProcedure`/`coachProcedure` coach-scoping mechanism
 * (packages/trpc/server/trpc.ts, added since 246b6bb — see docs/scenarios.md §1 research notes).
 * Every route built on it resolves `restrictToCoachId` server-side from the session and ANDs it
 * against `clients.assignedCoachId`/`sessions.coachId` in the repository — this suite actually
 * exercises that filter with a real "a DIFFERENT coach's client, same org" case, rather than
 * trusting the code read.
 *
 * Deliberately NOT testing against an "unassigned" client: `ClientsService.enrollClient` (and
 * `clients.join`'s self-service path) auto-assigns a coach via `resolveCoachForCentre` whenever
 * `coachId` isn't supplied — since the seed org's only centre has exactly one pre-existing coach
 * (coach@move.dev), every self-joined client silently lands on that same coach. A real second
 * coach (`createSecondSeedOrgCoach`) is the only way to get a client that's genuinely NOT
 * coach@move.dev's, without that auto-assignment fallback masking the test.
 */
describe("coach-scoping — a coach sees only clients assigned to them, not a colleague's", () => {
  let coach: SignedInSession;
  let ownCoachId: string;
  let ownClientId: string; // client@move.dev — seeded with assignedCoachId = coach@move.dev
  let colleagueClientId: string; // enrolled under a genuinely different, second coach

  beforeAll(async () => {
    coach = await signInAs("coach");
    ownCoachId = await getSeedCoachId();

    const seedClient = await signInAs("client");
    ownClientId = (await getClientProfile(seedClient.client)).id;

    const centreId = (await getSeedCentre()).id;
    const { coachId: secondCoachId } = await createSecondSeedOrgCoach("coach-scope-colleague");
    expect(secondCoachId).not.toBe(ownCoachId);

    const { client: owner } = await signInAs("owner");
    const enrollRes = await owner.post<{ data: { id: string } }>("/clients/enroll", {
      email: uniqueEmail("coach-scope-colleague-client"),
      name: "Colleague's Client",
      homeCentreId: centreId,
      coachId: secondCoachId,
    });
    expect(enrollRes.status).toBe(200);
    colleagueClientId = enrollRes.body!.data.id;
  }, 60_000);

  it("credits.getBalancesForClients withholds the colleague's actual balance data (but echoes the id key regardless — see note)", async () => {
    // A coach's own client had 1 SGPT credit granted during seed setup — assert real balance data.
    const res = await coach.client.post<{
      data: { clients: Array<{ clientId: string; balances: Array<{ balance: number }> }> };
    }>("/credits/balances-for-clients", {
      clientIds: [ownClientId, colleagueClientId],
    });
    expect(res.status).toBe(200);
    const rows = res.body?.data?.clients ?? [];

    // The security-relevant property: no ACTUAL balance numbers leak for a colleague's client.
    const colleagueRow = rows.find((c) => c.clientId === colleagueClientId);
    expect(colleagueRow?.balances ?? []).toEqual([]);

    // Minor note (not a security issue): `getBalancesForClients`' service layer
    // (packages/services/credits/index.ts) pre-seeds a `{clientId, balances: []}` entry for
    // EVERY requested id before applying the coach restriction, then never removes entries the
    // restriction excluded — it only ever empties their `balances`. So the colleague's clientId
    // key IS present in the response (with balances: []), unlike clients.list below, which omits
    // excluded rows entirely. No real financial data leaks, and — since this echoes back literally
    // any requested id, including ones that don't exist at all — it isn't an existence-probing
    // oracle either. Still an inconsistency worth flagging for cleanup (docs/scenarios.md §1.17).
    expect(rows.some((c) => c.clientId === colleagueClientId)).toBe(true);
  });

  it("clients.list (coach-scoped) includes the coach's own client but excludes a colleague's", async () => {
    const res = await coach.client.get<{ data: Array<{ id: string }> }>("/clients");
    expect(res.status).toBe(200);
    const ids = res.body?.data?.map((c) => c.id) ?? [];
    expect(ids).toContain(ownClientId);
    expect(ids).not.toContain(colleagueClientId);
  });

  it("an owner (elevated) sees both — the restriction is coach-specific, not a general filter bug", async () => {
    const { client: owner } = await signInAs("owner");
    const res = await owner.get<{ data: Array<{ id: string }> }>("/clients");
    expect(res.status).toBe(200);
    const ids = res.body?.data?.map((c) => c.id) ?? [];
    expect(ids).toContain(ownClientId);
    expect(ids).toContain(colleagueClientId);
  });
});
