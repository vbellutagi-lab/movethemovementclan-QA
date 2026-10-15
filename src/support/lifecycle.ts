import { randomInt } from "node:crypto";
import { newClient, type ApiClient } from "./api-client";
import { withAuthRateLimit } from "./auth-rate-limit";
import {
  createVerifiedUser,
  getSeedCentre,
  getSeedCoachId,
  getSeedOrg,
  inviteAndAccept,
} from "./fixtures";
import type { SessionListItem } from "./booking-helpers";
import { idempotencyKey, uniqueEmail } from "./random";
import {
  getClientProfile,
  setActiveOrganization,
  signIn,
  signInAs,
  type SignedInSession,
} from "./test-users";

/** The centre's calendar is IST — the server judges "today" / "in the past" by it. */
export function istDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

/** Own forged-proxy IP per fixture so provisioning never exhausts the 5/hr auth limiter (see client-pool.ts). */
function freshHeaders(): Record<string, string> {
  return { "x-forwarded-for": `198.51.100.${randomInt(1, 254)}` };
}

// ---- endpoint wrappers (all under /member-lifecycle) -----------------------------------------

export interface BookingDecision {
  bookingId: string;
  action: "CANCEL_AND_FREEZE" | "CANCEL_NO_REFUND";
}

export const lifecycle = {
  pause: (c: ApiClient, body: Record<string, unknown>) => c.post("/member-lifecycle/pause-client", body),
  resume: (c: ApiClient, clientId: string) => c.post("/member-lifecycle/resume-client", { clientId }),
  archiveClient: (c: ApiClient, body: Record<string, unknown>) =>
    c.post("/member-lifecycle/archive-client", body),
  restoreClient: (c: ApiClient, body: Record<string, unknown>) =>
    c.post("/member-lifecycle/restore-client", body),
  archiveCoach: (c: ApiClient, body: Record<string, unknown>) =>
    c.post("/member-lifecycle/archive-coach", body),
  restoreCoach: (c: ApiClient, coachId: string) => c.post("/member-lifecycle/restore-coach", { coachId }),
  coachImpact: (c: ApiClient, coachId: string) =>
    c.get<{
      data: {
        coachId: string;
        clients: { id: string; name: string; status: string }[];
        futureSessionCount: number;
        templateCount: number;
      };
    }>(`/member-lifecycle/coach-impact?coachId=${coachId}`),
  cancellationPolicy: (c: ApiClient) => c.get("/member-lifecycle/cancellation-policy"),
};

// ---- fixtures ---------------------------------------------------------------------------------

export interface LifecycleClient {
  client: ApiClient;
  email: string;
  password: string;
  userId: string;
  clientId: string;
}

/**
 * A brand-new verified user enrolled by the owner (staff "Add client") under an explicit coach,
 * so its coach is deterministic instead of whichever active coach is least loaded.
 */
export async function createLifecycleClient(
  label: string,
  coachId?: string,
): Promise<LifecycleClient> {
  const user = await createVerifiedUser(label, { defaultHeaders: freshHeaders() });
  const owner = await signInAs("owner");
  const centre = await getSeedCentre();
  const res = await owner.client.post<{ data: { id: string } }>("/clients/enroll", {
    email: user.email,
    name: label,
    homeCentreId: centre.id,
    coachId: coachId ?? (await getSeedCoachId()),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`enroll(${user.email}) failed: HTTP ${res.status} ${res.rawText.slice(0, 300)}`);
  }
  const profile = await getClientProfile(user.client);
  return { ...user, clientId: profile.id };
}

export interface LifecycleCoach {
  session: SignedInSession;
  password: string;
  coachId: string;
  userId: string;
  name: string;
}

const COACH_PASSWORD = "Qa-Fresh-Pass-1!"; // createVerifiedUser's fixed password
const leasedThisProcess = new Set<string>();

/**
 * Throwaway coaches are org members and a member can't be removed over HTTP by this suite, so
 * minting a new one every run would eat the org's seat limit (Better Auth default: 100) and
 * eventually fail with ORGANIZATION_MEMBERSHIP_LIMIT_REACHED. Instead, earlier throwaway coaches
 * ("lc-*", left ARCHIVED by LifecycleCleanup) are leased back: restored to ACTIVE here and
 * archived again by cleanup. Returns null when none is free.
 */
async function leaseArchivedCoach(): Promise<LifecycleCoach | null> {
  const owner = await signInAs("owner");
  const org = await getSeedOrg();
  const members = await owner.client.authGet<{
    members: { organizationId: string; user: { id: string; email: string; name: string } }[];
  }>(`/organization/list-members?organizationId=${org.id}&limit=500`);
  const coaches = await owner.client.get<{ data: { id: string; name: string; status: string }[] }>("/coaches");
  const byName = new Map((coaches.body?.data ?? []).map((c) => [c.name, c]));

  for (const m of members.body?.members ?? []) {
    if (!/^lc-[a-z0-9-]+\+\d+-[a-z0-9]+@move-qa\.test$/.test(m.user.email)) continue;
    const coach = byName.get(m.user.name);
    if (!coach || coach.status !== "ARCHIVED" || leasedThisProcess.has(coach.id)) continue;

    const restored = await lifecycle.restoreCoach(owner.client, coach.id);
    if (restored.status !== 200) continue;
    leasedThisProcess.add(coach.id);
    const client = newClient(freshHeaders());
    const res = await withAuthRateLimit(`sign-in(${m.user.email})`, () =>
      client.authPost<{ user?: { id: string } }>("/sign-in/email", {
        email: m.user.email,
        password: COACH_PASSWORD,
      }),
    );
    if (res.status !== 200 || !res.body?.user?.id) {
      await lifecycle.archiveCoach(owner.client, {
        coachId: coach.id,
        reason: "QA lease failed",
        clientAssignments: [],
        sessionsPolicy: { mode: "CANCEL" },
      });
      continue;
    }
    await setActiveOrganization(client, org.id);
    return {
      session: { client, userId: res.body.user.id, email: m.user.email },
      password: COACH_PASSWORD,
      coachId: coach.id,
      userId: res.body.user.id,
      name: m.user.name,
    };
  }
  return null;
}

/** A genuine extra coach (org role member + coach profile at the seed centre), never a seed login. */
export async function createLifecycleCoach(label: string): Promise<LifecycleCoach> {
  const leased = await leaseArchivedCoach();
  if (leased) return leased;

  const name = `lc-${label.replace(/^lc-/, "")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const fresh = await createVerifiedUser(name, { defaultHeaders: freshHeaders() });
  const org = await getSeedOrg();
  const centre = await getSeedCentre();
  const owner = await signInAs("owner");

  try {
    await inviteAndAccept(owner.client, org.id, fresh, "member");
  } catch (e) {
    if (String(e).includes("MEMBERSHIP_LIMIT")) {
      throw new Error(
        "The seed org is at its member limit and no archived 'lc-*' throwaway coach is free to " +
          "reuse. Free seats (reseed, or remove old QA members) before running the lifecycle suite.",
      );
    }
    throw e;
  }
  await setActiveOrganization(fresh.client, org.id);
  const done = await fresh.client.post("/coaches/complete-profile", { centreId: centre.id });
  if (done.status !== 200) {
    throw new Error(`coaches.complete-profile failed: HTTP ${done.status} ${done.rawText.slice(0, 300)}`);
  }
  const list = await owner.client.get<{ data: { id: string; name: string }[] }>("/coaches");
  const coach = list.body?.data?.find((c) => c.name === name);
  if (!coach) throw new Error(`Could not resolve coaches.id for ${fresh.email}`);
  return { session: fresh, password: fresh.password, coachId: coach.id, userId: fresh.userId, name };
}

/** Gives an existing user (e.g. a throwaway coach) a client profile too — "coach who is also a client". */
export async function enrollExistingUserAsClient(email: string, name: string, coachId: string) {
  const owner = await signInAs("owner");
  const centre = await getSeedCentre();
  const res = await owner.client.post("/clients/enroll", { email, name, homeCentreId: centre.id, coachId });
  if (res.status !== 409) return res;

  // A leased coach may still carry the (archived) client profile from an earlier run: restore it.
  const found = await owner.client.get<{ data: { clients: { id: string; email: string; status: string }[] } }>(
    `/clients/search?search=${encodeURIComponent(email)}&limit=5`,
  );
  const row = found.body?.data?.clients?.find((c) => c.email === email);
  if (row?.status === "ARCHIVED") {
    return lifecycle.restoreClient(owner.client, { clientId: row.id, newCoachId: coachId, lotDecisions: [] });
  }
  return res;
}

export async function grantCredits(
  clientId: string,
  creditType: string,
  amount: number,
  opts: { expiresAt?: string | null } = {},
): Promise<string> {
  const owner = await signInAs("owner");
  const res = await owner.client.post<{ data: { lotId: string } }>("/credits/grant", {
    clientId,
    creditType,
    amount,
    expiresAt: opts.expiresAt ?? null,
    centreScope: null,
    reason: "QA member-lifecycle fixture",
  });
  if (res.status !== 200) {
    throw new Error(`grant failed: HTTP ${res.status} ${res.rawText.slice(0, 300)}`);
  }
  return res.body.data.lotId;
}

export interface Lot {
  id: string;
  creditType: string;
  granted: number;
  remaining: number;
  expiresAt: string | null;
}

export async function lotsFor(clientId: string): Promise<Lot[]> {
  const owner = await signInAs("owner");
  const res = await owner.client.get<{ data: { lots: Lot[] } }>(
    `/credits/lots-for-client?clientId=${clientId}`,
  );
  return res.body?.data?.lots ?? [];
}

export async function balances(clientId: string, creditType: string) {
  const owner = await signInAs("owner");
  const res = await owner.client.get<{
    data: { balances: { creditType: string; balance: number; frozenBalance: number }[] };
  }>(`/credits/balances?clientId=${clientId}`);
  const row = res.body?.data?.balances?.find((b) => b.creditType === creditType);
  return { balance: row?.balance ?? 0, frozen: row?.frozenBalance ?? 0 };
}

const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

/** Weekday name (in the centre's IST calendar) of the day `offset` days from today. */
export function istWeekday(offset: number): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[new Date(`${istDate(offset)}T12:00:00Z`).getUTCDay()]!;
}

/**
 * Seeds `count` roomy (capacity 20), non-overlapping group sessions, 2+ days out, so a test never
 * depends on whatever sessions the dev seed happens to have left (they run out or drift with the
 * clock). A throwaway "host" coach gets one weekly class per day at 05:05 IST; materialise turns
 * them into real sessions. Everything is registered with `cleanup`: deleting the weekly classes
 * cancels their sessions, and the host coach is archived.
 */
export async function seedBookableSessions(
  cleanup: LifecycleCleanup,
  count: number,
): Promise<SessionListItem[]> {
  const owner = await signInAs("owner");
  const host = cleanup.trackCoach(await createLifecycleCoach("lc-host"));

  // Borrow the session type + centre of a seeded group class (capacity > 1, i.e. not a 1:1 PT).
  const existing = await owner.client.get<{
    data: { sessionTypeId: string; centreId: string; capacity: number }[];
  }>("/class-templates");
  const group = existing.body.data.find((t) => t.capacity > 1);
  if (!group) throw new Error("No seeded group class template to borrow — reseed.");

  for (let i = 0; i < count; i++) {
    const res = await owner.client.post<{ data: { id: string } }>("/class-templates", {
      sessionTypeId: group.sessionTypeId,
      centreId: group.centreId,
      coachId: host.coachId,
      weekday: istWeekday(2 + i),
      startTime: "05:05",
      capacity: 20,
      activeFrom: istDate(),
    });
    if (res.status !== 200) {
      throw new Error(`template for host coach failed: HTTP ${res.status} ${res.rawText.slice(0, 300)}`);
    }
    cleanup.trackTemplate(res.body.data.id);
  }
  const mat = await owner.client.post("/scheduling/materialise", {});
  if (mat.status !== 200) throw new Error(`materialise failed: HTTP ${mat.status}`);

  // Read through the seed client (it holds credits of the group type, so it is shown the
  // sessions; read-only) and keep the earliest session of each weekly class.
  const seedClient = (await signInAs("client")).client;
  const from = new Date(Date.now() + 30 * 3_600_000).toISOString();
  const to = new Date(Date.now() + 9 * 86_400_000).toISOString();
  const res = await seedClient.get<{ data: { sessions: SessionListItem[] } }>(
    `/sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`,
  );
  const mine = (res.body?.data?.sessions ?? [])
    .filter((x) => x.coachId === host.coachId)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, count);
  if (mine.length < count) {
    throw new Error(`Seeded ${count} weekly classes but only found ${mine.length} sessions for them.`);
  }
  return mine;
}

export async function book(c: ApiClient, sessionId: string) {
  return c.post<{ data: { id: string; status: string } }>("/bookings", {
    sessionId,
    idempotencyKey: idempotencyKey("lc"),
  });
}

export async function clientStatus(clientId: string): Promise<string | undefined> {
  const owner = await signInAs("owner");
  const res = await owner.client.get<{ data: { status: string } }>(`/clients/${clientId}`);
  return res.body?.data?.status;
}

export async function coachStatus(coachId: string): Promise<string | undefined> {
  const owner = await signInAs("owner");
  const res = await owner.client.get<{ data: { status: string } }>(`/coaches/${coachId}`);
  return res.body?.data?.status;
}

/** Fresh sign-in attempt (no cookie reuse) — used to prove a ban / unban. */
export async function trySignIn(email: string, password: string) {
  try {
    await signIn(email, password);
    return true;
  } catch {
    return false;
  }
}

// ---- cleanup ----------------------------------------------------------------------------------

/**
 * Collects throwaway members and winds them down at the end of a file: cancels their bookings,
 * moves/archives clients (ends ARCHIVED & banned — nothing else depends on them) and archives
 * throwaway coaches after handing clients to the seed coach. Best-effort: never throws.
 */
export class LifecycleCleanup {
  private clients: LifecycleClient[] = [];
  private coaches: LifecycleCoach[] = [];
  private templates: string[] = [];

  trackClient(c: LifecycleClient) {
    this.clients.push(c);
    return c;
  }
  trackCoach(c: LifecycleCoach) {
    this.coaches.push(c);
    return c;
  }
  trackTemplate(id: string) {
    this.templates.push(id);
  }

  async run() {
    const swallow = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best effort */
      }
    };
    const owner = await signInAs("owner");
    const seedCoachId = await getSeedCoachId();

    for (const id of this.templates) await swallow(() => owner.client.post("/class-templates/delete", { id }));

    for (const c of this.clients) {
      await swallow(async () => {
        const status = await clientStatus(c.clientId);
        if (status === "ARCHIVED") return;
        // Cancel whatever is still booked so no seats stay held, then archive (also bans the login).
        const list = await owner.client.get<{
          data: { bookings: { id: string; status: string }[] };
        }>(`/booking-oversight/list-for-client?clientId=${c.clientId}&filter=upcoming`);
        const decisions: BookingDecision[] = (list.body?.data?.bookings ?? [])
          .filter((b) => b.status === "CONFIRMED")
          .map((b) => ({ bookingId: b.id, action: "CANCEL_NO_REFUND" as const }));
        await lifecycle.archiveClient(owner.client, {
          clientId: c.clientId,
          reason: "QA cleanup",
          bookingDecisions: decisions,
        });
      });
    }

    for (const coach of this.coaches) {
      await swallow(async () => {
        if ((await coachStatus(coach.coachId)) === "ARCHIVED") return;
        const impact = await lifecycle.coachImpact(owner.client, coach.coachId);
        await lifecycle.archiveCoach(owner.client, {
          coachId: coach.coachId,
          reason: "QA cleanup",
          clientAssignments: (impact.body?.data?.clients ?? []).map((cl) => ({
            clientId: cl.id,
            newCoachId: seedCoachId,
          })),
          sessionsPolicy: { mode: "CANCEL" },
        });
      });
    }
  }
}

export { uniqueEmail };
