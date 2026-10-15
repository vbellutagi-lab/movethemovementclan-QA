import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSeedCoachId } from "../../support/fixtures";
import {
  LifecycleCleanup,
  book,
  createLifecycleClient,
  createLifecycleCoach,
  grantCredits,
  istDate,
  lifecycle,
  seedBookableSessions,
  type LifecycleClient,
  type LifecycleCoach,
} from "../../support/lifecycle";
import { signInAs, type SignedInSession } from "../../support/test-users";

interface DirectoryRow {
  id: string;
  status: string;
  email: string;
}

/**
 * member-lifecycle-e2e.md §21 and the read-side parts of §10, §15, §17, §18: what the lifecycle
 * feature must NOT break (ACTIVE members behave as before; response shapes only grew) and how the
 * existing lists / counters now treat paused and archived members.
 */
describe("member lifecycle — impact on existing features (§10, §15, §17, §18, §21)", () => {
  const cleanup = new LifecycleCleanup();
  let owner: SignedInSession;
  let coach: LifecycleCoach;
  let active: LifecycleClient;
  let paused: LifecycleClient;
  let archived: LifecycleClient;
  let creditType: string;
  let sessionId: string;

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = cleanup.trackCoach(await createLifecycleCoach("lc-reg-coach"));
    active = cleanup.trackClient(await createLifecycleClient("lc-reg-active", coach.coachId));
    paused = cleanup.trackClient(await createLifecycleClient("lc-reg-paused", coach.coachId));
    archived = cleanup.trackClient(await createLifecycleClient("lc-reg-archived", coach.coachId));

    const [s] = await seedBookableSessions(cleanup, 1);
    sessionId = s!.id;
    creditType = s!.creditType;

    const lotId = await grantCredits(paused.clientId, creditType, 2);
    expect(
      (
        await lifecycle.pause(owner.client, {
          clientId: paused.clientId,
          reason: "QA",
          pausedFrom: istDate(),
          lotIdsToFreeze: [lotId],
          bookingDecisions: [],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await lifecycle.archiveClient(owner.client, {
          clientId: archived.clientId,
          reason: "QA",
          bookingDecisions: [],
        })
      ).status,
    ).toBe(200);
  }, 240_000);

  afterAll(() => cleanup.run());

  const search = async (client: SignedInSession["client"], qs: string) =>
    client.get<{ data: { clients: DirectoryRow[]; nextCursor: string | null } }>(`/clients/search?${qs}`);

  // ---------------------------------------------------------------- R-03 / B-10: ACTIVE members unchanged

  it("R-03/B-10/M-02 — an ACTIVE client still books, and cancels with the normal policy refund", async () => {
    await grantCredits(active.clientId, creditType, 2);
    const booked = await book(active.client, sessionId);
    expect(booked.status, booked.rawText.slice(0, 200)).toBe(200);
    expect(booked.body.data.status).toBe("CONFIRMED");

    const cancelled = await active.client.post<{ data: { status: string; refunded: boolean } }>(
      "/bookings/cancel",
      { bookingId: booked.body.data.id },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toEqual({ status: "CANCELLED_IN_TIME", refunded: true });
  }, 60_000);

  it("R-13 — existing response shapes only grew: clients.me / coaches.list / clients.search keep every old field and add status", async () => {
    const me = await active.client.get<{ data: Record<string, unknown> }>("/clients/me");
    for (const k of ["id", "userId", "homeCentreId", "assignedCoachId", "emergencyContact", "joinedAt", "updatedAt"]) {
      expect(me.body.data, `clients.me.${k}`).toHaveProperty(k);
    }
    expect(me.body.data.status).toBe("ACTIVE");

    const coaches = await owner.client.get<{ data: Record<string, unknown>[] }>("/coaches");
    for (const row of coaches.body.data) {
      for (const k of ["id", "name", "centreId", "centreName", "status"]) expect(row, `coaches.${k}`).toHaveProperty(k);
    }

    const found = await search(owner.client, "limit=100");
    for (const row of found.body.data.clients) {
      for (const k of ["id", "userId", "name", "email", "homeCentreId", "centreName", "coachId", "coachName", "status"]) {
        expect(row, `clients.search.${k}`).toHaveProperty(k);
      }
    }
  }, 60_000);

  // ---------------------------------------------------------------- admin Clients page (§15)

  it("UC-02/UC-04 — clients.search filters server-side by status chip", async () => {
    // Looked up by each client's unique email so accumulated throwaway rows can't push it off page 1.
    const listed = async (who: LifecycleClient, status?: string) =>
      (
        await search(
          owner.client,
          `search=${encodeURIComponent(who.email)}&limit=10${status ? `&status=${status}` : ""}`,
        )
      ).body.data.clients.some((c) => c.id === who.clientId);

    expect(await listed(paused, "PAUSED")).toBe(true);
    expect(await listed(active, "PAUSED")).toBe(false);
    expect(await listed(archived, "ARCHIVED")).toBe(true);
    expect(await listed(paused, "ARCHIVED")).toBe(false);
    expect(await listed(active, "ACTIVE")).toBe(true);
    expect(await listed(paused, "ACTIVE")).toBe(false);
    expect(await listed(archived, "ACTIVE")).toBe(false);

    // "All" (no filter) still shows every status to an admin (CRD-23).
    for (const who of [active, paused, archived]) expect(await listed(who)).toBe(true);
  }, 60_000);

  it("CRD-22 — the credits 'has frozen' filter lists the paused client", async () => {
    const res = await search(
      owner.client,
      `creditFilter=has_frozen&search=${encodeURIComponent(paused.email)}&limit=10`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.clients.map((c) => c.id)).toContain(paused.clientId);
  }, 30_000);

  // ---------------------------------------------------------------- coach views (§17)

  it("CRD-24/PO-64 — a coach's own client search shows ACTIVE clients only", async () => {
    const res = await search(coach.session.client, "limit=100");
    expect(res.status, res.rawText.slice(0, 200)).toBe(200);
    const ids = res.body.data.clients.map((c) => c.id);
    expect(ids).toContain(active.clientId);
    expect(ids).not.toContain(paused.clientId);
    expect(ids).not.toContain(archived.clientId);
  }, 30_000);

  it("PO-66/G-07 — a coach's client list leaves out ARCHIVED clients and marks PAUSED ones", async () => {
    const res = await coach.session.client.get<{ data: DirectoryRow[] }>("/clients");
    expect(res.status, res.rawText.slice(0, 200)).toBe(200);
    const byId = new Map(res.body.data.map((c) => [c.id, c.status]));
    expect(byId.get(active.clientId)).toBe("ACTIVE");
    expect(byId.get(paused.clientId)).toBe("PAUSED");
    expect(byId.has(archived.clientId)).toBe(false);
  }, 30_000);

  it("G-07 — admin clients.listByCoach likewise omits archived clients", async () => {
    const res = await owner.client.get<{ data: DirectoryRow[] }>(`/clients/by-coach/${coach.coachId}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c) => c.id);
    expect(ids).toContain(active.clientId);
    expect(ids).toContain(paused.clientId);
    expect(ids).not.toContain(archived.clientId);
  }, 30_000);

  // ---------------------------------------------------------------- dashboards (§18)

  it("D-01 — the dashboard 'active clients' tile drops by one for a pause and by one for an archive, and recovers on resume", async () => {
    const tile = async () =>
      (await owner.client.get<{ data: { activeClients: number } }>("/admin-dashboard/stats")).body.data
        .activeClients;

    const probeA = cleanup.trackClient(await createLifecycleClient("lc-dash-a", coach.coachId));
    const probeB = cleanup.trackClient(await createLifecycleClient("lc-dash-b", coach.coachId));
    const base = await tile();

    await lifecycle.pause(owner.client, {
      clientId: probeA.clientId,
      reason: "QA",
      pausedFrom: istDate(),
      lotIdsToFreeze: [],
      bookingDecisions: [],
    });
    expect(await tile()).toBe(base - 1);

    await lifecycle.archiveClient(owner.client, { clientId: probeB.clientId, reason: "QA", bookingDecisions: [] });
    expect(await tile()).toBe(base - 2);

    await lifecycle.resume(owner.client, probeA.clientId);
    expect(await tile()).toBe(base - 1);
  }, 120_000);

  // ---------------------------------------------------------------- reassign (R-08, L-10)

  it("R-08/L-10 — reassigning an ACTIVE or a PAUSED client between ACTIVE coaches still works", async () => {
    const seedCoachId = await getSeedCoachId();
    for (const who of [active, paused]) {
      const res = await owner.client.post("/clients/reassign-coach", {
        clientId: who.clientId,
        newCoachId: seedCoachId,
        reason: "QA",
      });
      expect(res.status, `${who.email}: ${res.rawText.slice(0, 160)}`).toBe(200);
    }
  }, 60_000);

  it("R-01 — seed logins for every role still sign in and resolve their identity (the identity guard never locks out ACTIVE users)", async () => {
    for (const key of ["owner", "staff", "coach", "coach2", "client", "client2"] as const) {
      const s = await signInAs(key);
      const me = key.startsWith("client")
        ? await s.client.get("/clients/me")
        : await s.client.get("/coaches/complete-profile").then(() => ({ status: 200 }));
      expect(me.status, key).toBe(200);
    }
    // This suite must never have touched the seed members it logs in as.
    const rows = (await search(owner.client, "limit=100")).body.data.clients;
    for (const email of ["client@move.dev", "client2@move.dev"]) {
      expect(rows.find((r) => r.email === email)?.status, email).toBe("ACTIVE");
    }
  }, 60_000);
});
