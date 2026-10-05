import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCreditType,
  listCreditTypes,
  retireCreditType,
  uniqueCreditTypeCode,
  type CreditTypeDto,
} from "../../support/credit-types";
import { nonExistentUuid } from "../../support/random";
import { signInAs, type SignedInSession } from "../../support/test-users";

/** feature/credit-types checklist sections A, B, C — create / list / edit through the API. */
describe("credit types — create, list, edit (checklist A–C)", () => {
  let owner: SignedInSession;
  const created: CreditTypeDto[] = [];

  beforeAll(async () => {
    owner = await signInAs("owner");
  }, 30_000);

  afterAll(async () => {
    for (const t of created) await retireCreditType(owner.client, t.id);
  });

  it("A2 — the seeded SGPT / PT / COND types are listed with code, short name, full name and colour", async () => {
    const { status, types } = await listCreditTypes(owner.client);
    expect(status).toBe(200);
    for (const code of ["SGPT", "PT", "COND"]) {
      const t = types.find((x) => x.code === code);
      expect(t, `seeded credit type ${code}`).toBeTruthy();
      expect(t!.active).toBe(true);
      expect(t!.name.length).toBeGreaterThan(0);
      expect(t!.fullName.length).toBeGreaterThan(0);
      expect(t!.color.length).toBeGreaterThan(0);
    }
  });

  it("B1 — creates a credit type and it appears in the list immediately, active, with the chosen colour", async () => {
    const t = await createCreditType(owner.client, { color: "teal" });
    created.push(t);
    expect(t.active).toBe(true);
    expect(t.color).toBe("teal");

    const { types } = await listCreditTypes(owner.client);
    expect(types.find((x) => x.id === t.id)?.code).toBe(t.code);
  });

  it("B2 — empty code / name / fullName are rejected (400) and nothing is created", async () => {
    const base = { code: uniqueCreditTypeCode(), name: "n", fullName: "f", color: "teal" };
    for (const bad of [{ ...base, code: "" }, { ...base, name: "" }, { ...base, fullName: "" }]) {
      const res = await owner.client.post("/credit-types", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const { types } = await listCreditTypes(owner.client, true);
    expect(types.find((x) => x.code === base.code)).toBeUndefined();
  });

  it("B3 — a code with a space/symbol or longer than 12 chars is rejected; exactly 12 is accepted", async () => {
    const base = { name: "n", fullName: "f", color: "teal" };
    const spaced = await owner.client.post("/credit-types", { ...base, code: "bad code!" });
    expect(spaced.status).toBe(400);
    const tooLong = await owner.client.post("/credit-types", {
      ...base,
      code: uniqueCreditTypeCode("L").padEnd(13, "X"),
    });
    expect(tooLong.status).toBe(400);

    const twelve = await createCreditType(owner.client, { code: uniqueCreditTypeCode("T").padEnd(12, "Z") });
    created.push(twelve);
    expect(twelve.code).toHaveLength(12);
  });

  it("B4 — a lowercase code is saved upper-cased", async () => {
    const lower = uniqueCreditTypeCode("lc").toLowerCase();
    const t = await createCreditType(owner.client, { code: lower });
    created.push(t);
    expect(t.code).toBe(lower.toUpperCase());
  });

  it("B5 — a duplicate code is a 409 and does not create a second row", async () => {
    const res = await owner.client.post("/credit-types", {
      code: "SGPT",
      name: "dup",
      fullName: "dup",
      color: "teal",
    });
    expect(res.status).toBe(409);
    const { types } = await listCreditTypes(owner.client, true);
    expect(types.filter((x) => x.code === "SGPT")).toHaveLength(1);
  });

  it("B6 — every palette colour is accepted; an unknown colour is rejected", async () => {
    for (const color of ["sgpt", "pt", "cond", "violet", "teal", "rose", "amber", "slate"]) {
      const t = await createCreditType(owner.client, { color });
      created.push(t);
      expect(t.color).toBe(color);
    }
    const bad = await owner.client.post("/credit-types", {
      code: uniqueCreditTypeCode(),
      name: "n",
      fullName: "f",
      color: "hot-pink",
    });
    expect(bad.status).toBe(400);
  });

  it("C1 — edit changes name, full name and colour but never the code", async () => {
    const t = await createCreditType(owner.client);
    created.push(t);
    const res = await owner.client.post<{ data: CreditTypeDto }>("/credit-types/update", {
      id: t.id,
      name: "Renamed",
      fullName: "Renamed in full",
      color: "rose",
      code: "HACKED", // code is immutable — must be ignored or rejected, never applied
    });
    if (res.status === 200) {
      expect(res.body.data).toMatchObject({ code: t.code, name: "Renamed", color: "rose" });
    } else {
      expect(res.status).toBe(400);
    }
    const after = (await listCreditTypes(owner.client, true)).types.find((x) => x.id === t.id)!;
    expect(after.code).toBe(t.code);
  });

  it("C3 — an update with no fields is a clean 400, not a 500", async () => {
    const t = await createCreditType(owner.client);
    created.push(t);
    const res = await owner.client.post("/credit-types/update", { id: t.id });
    expect(res.status).toBe(400);
  });

  it("C — updating a credit type that does not exist is a 404", async () => {
    const res = await owner.client.post("/credit-types/update", { id: nonExistentUuid(), name: "x" });
    expect(res.status).toBe(404);
  });
});
