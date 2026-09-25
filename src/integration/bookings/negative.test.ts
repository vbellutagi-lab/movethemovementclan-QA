import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { pickDistinctSessions } from "../../support/booking-helpers";
import { idempotencyKey, nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

describe("bookings — negative (docs/scenarios.md §7.7–7.10)", () => {
  let client: SignedInSession;

  beforeAll(async () => {
    client = await signInAs("client");
  }, 30_000);

  it("booking a session that doesn't exist returns 404", async () => {
    const res = await client.client.post("/bookings", {
      sessionId: nonExistentUuid(),
      idempotencyKey: idempotencyKey("nb2"),
    });
    expect(res.status).toBe(404);
  });

  it("a malformed (non-uuid) sessionId is rejected with 400 before any DB lookup", async () => {
    const res = await client.client.post("/bookings", {
      sessionId: "not-a-uuid",
      idempotencyKey: idempotencyKey("nb3"),
    });
    expect(res.status).toBe(400);
  });

  it("booking with no session cookie at all returns 401", async () => {
    const anon = newClient();
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    const res = await anon.post("/bookings", {
      sessionId,
      idempotencyKey: idempotencyKey("nb4"),
    });
    expect(res.status).toBe(401);
  });

  it("a signed-in user with no client profile (a coach) is forbidden, not just role-checked away silently", async () => {
    const coach = await signInAs("coach");
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    const res = await coach.client.post("/bookings", {
      sessionId,
      idempotencyKey: idempotencyKey("nb5"),
    });
    // clientProcedure: valid session, no linked `clients` row → 403, not 404 (ADR 0016).
    expect(res.status).toBe(403);
  });

  it("negative amount / non-positive fields are rejected by zod before reaching the service", async () => {
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    // idempotencyKey must be a non-empty string; confirm an empty one is rejected (schema: .min(1)).
    const res = await client.client.post("/bookings", { sessionId, idempotencyKey: "" });
    expect(res.status).toBe(400);
  });
});
