import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { createSecondSeedOrgCoach, getSeedCentre, getSeedCoachId } from "../../support/fixtures";
import { nonExistentUuid, uniqueEmail } from "../../support/random";
import { getClientProfile, signInAs, type SignedInSession } from "../../support/test-users";

/**
 * New in v1.1.0->develop: session-stats tiles (bookings.myStats / getStatsForClient /
 * getStatsForClients) and attendance history (bookings.myAttendanceHistory /
 * getAttendanceHistoryForClient) — back /client/attendance, /admin/attendance, /staff/attendance,
 * the coach-profile Clients tab, and the client-detail page's stat tiles. Read-only, but the
 * coach/admin-scoped variants carry the same cross-tenant/cross-coach authorization risk as
 * credits.getBalancesForClients (see coach-scoping.test.ts) — that's the highest-value thing to
 * verify black-box, not the arithmetic (already covered by the app's own service unit tests).
 */
describe("bookings — session stats & attendance history", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let client: SignedInSession;
  let clientId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");
    client = await signInAs("client");
    clientId = (await getClientProfile(client.client)).id;
  }, 30_000);

  it("myStats / myAttendanceHistory — a client reads their own data", async () => {
    const stats = await client.client.get<{
      data: { sessionsBooked: number; sessionsAttended: number; sessionsCancelled: number };
    }>("/bookings/my-stats");
    expect(stats.status).toBe(200);
    expect(typeof stats.body?.data?.sessionsBooked).toBe("number");

    const history = await client.client.get<{
      data: { bookings: unknown[]; nextCursor: string | null };
    }>("/bookings/my-attendance-history");
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body?.data?.bookings)).toBe(true);
  });

  it("getStatsForClient / getAttendanceHistoryForClient — admin reads any client in the org", async () => {
    const stats = await owner.client.get<{ data: { sessionsBooked: number } }>(
      `/bookings/stats-for-client?clientId=${clientId}`,
    );
    expect(stats.status).toBe(200);

    const history = await owner.client.get<{ data: { bookings: unknown[] } }>(
      `/bookings/attendance-history-for-client?clientId=${clientId}`,
    );
    expect(history.status).toBe(200);
  });

  it("getStatsForClients — batched form returns one entry per requested clientId", async () => {
    const res = await owner.client.post<{
      data: { clients: Array<{ clientId: string; sessionsBooked: number }> };
    }>("/bookings/stats-for-clients", { clientIds: [clientId] });
    expect(res.status).toBe(200);
    expect(res.body?.data?.clients.some((c) => c.clientId === clientId)).toBe(true);
  });

  it("a client cannot call the admin/coach-facing endpoints (getStatsForClient, getStatsForClients, getAttendanceHistoryForClient)", async () => {
    const stats = await client.client.get(`/bookings/stats-for-client?clientId=${clientId}`);
    expect(stats.status).toBe(403);

    const batch = await client.client.post("/bookings/stats-for-clients", {
      clientIds: [clientId],
    });
    expect(batch.status).toBe(403);

    const history = await client.client.get(
      `/bookings/attendance-history-for-client?clientId=${clientId}`,
    );
    expect(history.status).toBe(403);
  });

  it("with no session at all, every endpoint here returns 401", async () => {
    const anon = newClient();
    expect((await anon.get("/bookings/my-stats")).status).toBe(401);
    expect((await anon.get("/bookings/my-attendance-history")).status).toBe(401);
    expect((await anon.get(`/bookings/stats-for-client?clientId=${clientId}`)).status).toBe(401);
    expect((await anon.post("/bookings/stats-for-clients", { clientIds: [clientId] })).status).toBe(
      401,
    );
  });

  it("getStatsForClient / getAttendanceHistoryForClient on a client that doesn't exist returns 404", async () => {
    const stats = await owner.client.get(`/bookings/stats-for-client?clientId=${nonExistentUuid()}`);
    expect(stats.status).toBe(404);

    const history = await owner.client.get(
      `/bookings/attendance-history-for-client?clientId=${nonExistentUuid()}`,
    );
    expect(history.status).toBe(404);
  });

  it("coach-scoping — a coach cannot read a colleague's client's stats/attendance (docs/scenarios.md's coach-scoping mechanism)", async () => {
    const seedCoachId = await getSeedCoachId();
    const centreId = (await getSeedCentre()).id;
    const { coachId: secondCoachId } = await createSecondSeedOrgCoach(
      "stats-attendance-colleague",
    );
    expect(secondCoachId).not.toBe(seedCoachId);

    const enrollRes = await owner.client.post<{ data: { id: string } }>("/clients/enroll", {
      email: uniqueEmail("stats-attendance-colleague-client"),
      name: "Colleague's Client (stats)",
      homeCentreId: centreId,
      coachId: secondCoachId,
    });
    expect(enrollRes.status).toBe(200);
    const colleagueClientId = enrollRes.body!.data.id;

    // `coach` (coach@move.dev / seedCoachId) is a genuinely different coach from secondCoachId —
    // reading the colleague's client must 404, the same existence-hiding posture used elsewhere.
    const stats = await coach.client.get(`/bookings/stats-for-client?clientId=${colleagueClientId}`);
    expect(stats.status).toBe(404);

    const history = await coach.client.get(
      `/bookings/attendance-history-for-client?clientId=${colleagueClientId}`,
    );
    expect(history.status).toBe(404);

    const batch = await coach.client.post<{
      data: { clients: Array<{ clientId: string; sessionsBooked: number; sessionsAttended: number; sessionsCancelled: number }> };
    }>("/bookings/stats-for-clients", { clientIds: [colleagueClientId] });
    // getSessionStatsForClients echoes the requested clientId back regardless of scope (same
    // withholding posture as credits.getBalancesForClients — see coach-scoping.test.ts), but a
    // client outside the caller's coach-scope gets zeroed stats rather than the real numbers.
    expect(batch.status).toBe(200);
    const entry = batch.body?.data?.clients.find((c) => c.clientId === colleagueClientId);
    expect(entry).toBeDefined();
    expect(entry?.sessionsBooked).toBe(0);
    expect(entry?.sessionsAttended).toBe(0);
    expect(entry?.sessionsCancelled).toBe(0);
  });
});
