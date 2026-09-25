import type { ApiClient } from "./api-client";

export interface SessionListItem {
  id: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookedCount: number;
  centreId: string;
  creditType: string;
  coachId: string;
}

/** GET /api/sessions as a signed-in client — home-centre-scoped, future-only (ADR 0037). */
export async function listBookableSessions(client: ApiClient): Promise<SessionListItem[]> {
  const res = await client.get<{ data: { sessions: SessionListItem[] } }>("/sessions");
  if (res.status !== 200) {
    throw new Error(`GET /sessions failed: HTTP ${res.status} ${res.rawText.slice(0, 300)}`);
  }
  return res.body?.data?.sessions ?? [];
}

/**
 * Picks distinct, non-overlapping, not-yet-full sessions for a test file to use one-per-test —
 * avoids `OverlappingBookingError` between test cases sharing the same client, and avoids two
 * tests racing for the same seat. Returns a fixed-length, non-undefined tuple (asserted at
 * runtime) so callers can destructure without `noUncheckedIndexedAccess` complaints.
 */
export async function pickDistinctSessions(
  client: ApiClient,
  count: number,
): Promise<SessionListItem[]> {
  const sessions = await listBookableSessions(client);
  const usable = sessions.filter((s) => s.bookedCount < s.capacity);
  if (usable.length < count) {
    throw new Error(
      `Need ${count} bookable sessions for the seed client's home centre, found ${usable.length}. ` +
        `Run scheduling.materialise (POST /api/scheduling/materialise as owner@move.dev) first.`,
    );
  }
  const picked = usable.slice(0, count);
  if (picked.some((s) => !s)) {
    throw new Error("pickDistinctSessions: internal invariant violated");
  }
  return picked;
}

/**
 * Picks EMPTY (bookedCount === 0) **group** sessions — i.e. any creditType other than "PT".
 *
 * Two reasons the capacity suite can't just use pickDistinctSessions:
 *  - A "PT" session is bookable only by the client whose `assignedCoachId` matches the
 *    session's coach (BookingCoachMismatchError → 403). A capacity race needs a session that
 *    every racer is *equally* allowed to book, so that the only thing which can reject a
 *    racer is the capacity guard itself — otherwise a 403 would masquerade as "capacity held".
 *  - The arithmetic in a capacity assertion ("exactly `capacity` winners") only holds if the
 *    session starts empty; a session carrying a leftover booking from a previous run would
 *    silently shift the expected winner count.
 *
 * Also returns them widely spaced in `startsAt` order, and callers must not have the same
 * client book two of them concurrently — overlapping bookings are rejected independently of
 * capacity (OverlappingBookingError → 409), which would be indistinguishable from a
 * capacity rejection by status code alone.
 */
export async function pickEmptyGroupSessions(
  client: ApiClient,
  count: number,
  opts: { minCapacity?: number } = {},
): Promise<SessionListItem[]> {
  const minCapacity = opts.minCapacity ?? 1;
  const sessions = await listBookableSessions(client);
  const usable = sessions.filter(
    (s) => s.creditType !== "PT" && s.bookedCount === 0 && s.capacity >= minCapacity,
  );
  if (usable.length < count) {
    throw new Error(
      `Need ${count} empty non-PT sessions with capacity >= ${minCapacity} for the seed ` +
        `client's home centre, found ${usable.length}. Re-run scheduling.materialise, or ` +
        `cancel leftover bookings from a previously-aborted run.`,
    );
  }
  return usable.slice(0, count);
}

/** Re-reads one session's live capacity/bookedCount straight from GET /api/sessions. */
export async function readSession(
  client: ApiClient,
  sessionId: string,
): Promise<SessionListItem | undefined> {
  const sessions = await listBookableSessions(client);
  return sessions.find((s) => s.id === sessionId);
}
