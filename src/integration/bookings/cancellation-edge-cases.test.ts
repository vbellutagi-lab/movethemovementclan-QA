import { beforeAll, describe, expect, it } from "vitest";
import { pickDistinctSessions } from "../../support/booking-helpers";
import { idempotencyKey } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

describe("bookings — cancellation edge cases (docs/scenarios.md §4.7)", () => {
  let client: SignedInSession;

  beforeAll(async () => {
    client = await signInAs("client");
  }, 30_000);

  it("§4.7 — cancelling the same booking twice is rejected the second time, not a double refund", async () => {
    const [{ id: sessionId }] = await pickDistinctSessions(client.client, 1);
    const booked = await client.client.post<{ data: { id: string } }>("/bookings", {
      sessionId,
      idempotencyKey: idempotencyKey("cancel-twice"),
    });
    expect(booked.status).toBe(200);
    const bookingId = booked.body!.data.id;

    const before = await client.client.get<{ data: { balances: { balance: number }[] } }>(
      "/credits/my-balances",
    );
    const beforeTotal = before.body!.data.balances.reduce((s, b) => s + b.balance, 0);

    const firstCancel = await client.client.post<{ data: { status: string; refunded: boolean } }>(
      "/bookings/cancel",
      { bookingId },
    );
    expect(firstCancel.status).toBe(200);
    expect(firstCancel.body?.data?.refunded).toBe(true);

    const secondCancel = await client.client.post("/bookings/cancel", { bookingId });
    // Whatever the exact status, it must NOT look like a second successful cancellation.
    expect(secondCancel.status).not.toBe(200);

    const after = await client.client.get<{ data: { balances: { balance: number }[] } }>(
      "/credits/my-balances",
    );
    const afterTotal = after.body!.data.balances.reduce((s, b) => s + b.balance, 0);
    // Exactly one refund, not two.
    expect(afterTotal).toBe(beforeTotal + 1);
  });
});
