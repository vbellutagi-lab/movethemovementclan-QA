import { beforeAll, describe, expect, it } from "vitest";
import { newClient } from "../../support/api-client";
import { nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

const WEEKDAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

/**
 * New in v1.1.0->develop: class-templates.delete now SOFT-deletes (and, per
 * ClassTemplatesService.deleteClassTemplate, cancels every not-yet-started session already
 * materialised from it) instead of hard-deleting. Nothing previously exercised delete at all.
 *
 * This suite verifies the black-box-observable contract (list hides a deleted template, a second
 * delete 404s, only admin/owner can delete) — the future-session-cancellation cascade itself is
 * already covered by the app's own class-templates-service.test.ts against a mocked db/tx, which
 * is the right tool for that pure logic (see README's "Why black-box" section for why this suite
 * doesn't re-derive it here).
 */
describe("class-templates — soft delete", () => {
  let owner: SignedInSession;
  let coach: SignedInSession;
  let reference: { sessionTypeId: string; centreId: string; coachId: string };

  beforeAll(async () => {
    owner = await signInAs("owner");
    coach = await signInAs("coach");

    const list = await owner.client.get<{
      data: Array<{ sessionTypeId: string; centreId: string; coachId: string }>;
    }>("/class-templates");
    expect(list.status).toBe(200);
    const first = list.body?.data?.[0];
    if (!first) {
      throw new Error(
        "No existing class template found to borrow sessionTypeId/centreId/coachId from — is the target instance seeded?",
      );
    }
    reference = first;
  }, 30_000);

  function freshTemplateInput(startTime: string) {
    const tomorrowWeekday = WEEKDAYS[(new Date().getDay() + 1) % 7]!;
    return {
      sessionTypeId: reference.sessionTypeId,
      centreId: reference.centreId,
      coachId: reference.coachId,
      weekday: tomorrowWeekday,
      startTime,
      capacity: 3,
      activeFrom: new Date().toISOString().slice(0, 10),
    };
  }

  it("creates, materialises, then soft-deletes a template — list hides it afterward", async () => {
    const create = await owner.client.post<{ data: { id: string } }>(
      "/class-templates",
      freshTemplateInput("06:15"),
    );
    expect(create.status).toBe(200);
    const templateId = create.body!.data.id;

    const materialise = await owner.client.post("/scheduling/materialise", {});
    expect(materialise.status).toBe(200);

    const beforeDelete = await owner.client.get<{ data: Array<{ id: string }> }>(
      "/class-templates",
    );
    expect(beforeDelete.body?.data?.some((t) => t.id === templateId)).toBe(true);

    const del = await owner.client.post<{ data: { id: string } }>("/class-templates/delete", {
      id: templateId,
    });
    expect(del.status).toBe(200);
    expect(del.body?.data?.id).toBe(templateId);

    const afterDelete = await owner.client.get<{ data: Array<{ id: string }> }>(
      "/class-templates",
    );
    expect(afterDelete.body?.data?.some((t) => t.id === templateId)).toBe(false);
  });

  it("deleting the same template twice returns 404 the second time", async () => {
    const create = await owner.client.post<{ data: { id: string } }>(
      "/class-templates",
      freshTemplateInput("06:30"),
    );
    const templateId = create.body!.data.id;

    const first = await owner.client.post("/class-templates/delete", { id: templateId });
    expect(first.status).toBe(200);

    const second = await owner.client.post("/class-templates/delete", { id: templateId });
    expect(second.status).toBe(404);
  });

  it("deleting a non-existent template returns 404", async () => {
    const res = await owner.client.post("/class-templates/delete", { id: nonExistentUuid() });
    expect(res.status).toBe(404);
  });

  it("create/delete as a non-admin org member (coach) is forbidden", async () => {
    const create = await coach.client.post("/class-templates", freshTemplateInput("06:45"));
    expect(create.status).toBe(403);

    const del = await coach.client.post("/class-templates/delete", { id: nonExistentUuid() });
    expect(del.status).toBe(403);
  });

  it("delete with no session at all returns 401", async () => {
    const anon = newClient();
    const res = await anon.post("/class-templates/delete", { id: nonExistentUuid() });
    expect(res.status).toBe(401);
  });
});
