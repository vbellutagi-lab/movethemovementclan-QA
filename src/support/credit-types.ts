import { randomUUID } from "node:crypto";
import type { ApiClient } from "./api-client";

export interface CreditTypeDto {
  id: string;
  code: string;
  name: string;
  fullName: string;
  color: string;
  active: boolean;
}

/** A unique, valid credit-type code (<= 12 chars, letters/digits) so reruns never collide. */
export function uniqueCreditTypeCode(prefix = "Q"): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 8)}`.toUpperCase().slice(0, 12);
}

export async function createCreditType(
  owner: ApiClient,
  overrides: Partial<{ code: string; name: string; fullName: string; color: string }> = {},
): Promise<CreditTypeDto> {
  const code = overrides.code ?? uniqueCreditTypeCode();
  const res = await owner.post<{ data: CreditTypeDto }>("/credit-types", {
    code,
    name: overrides.name ?? `QA ${code}`,
    fullName: overrides.fullName ?? `QA credit type ${code}`,
    color: overrides.color ?? "teal",
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`createCreditType(${code}) failed: HTTP ${res.status} ${res.rawText.slice(0, 300)}`);
  }
  return res.body.data;
}

export async function listCreditTypes(client: ApiClient, includeInactive = false) {
  const res = await client.get<{ data: CreditTypeDto[] }>(
    `/credit-types${includeInactive ? "?includeInactive=true" : ""}`,
  );
  return { status: res.status, types: res.body?.data ?? [], raw: res };
}

/**
 * Credit types have no delete endpoint, so tests retire what they create: freeze whatever is
 * left and deactivate. Best-effort — never throws, so it is safe in `afterAll`/`finally`.
 */
export async function retireCreditType(owner: ApiClient, id: string): Promise<void> {
  try {
    await owner.post("/credit-types/deactivate", { id, lotAction: "FREEZE", packageAction: "KEEP" });
  } catch {
    /* best effort */
  }
}

/** Balance row for one credit code from the owner's view of a client. */
export async function balanceFor(owner: ApiClient, clientId: string, code: string) {
  const res = await owner.get<{
    data: { balances: { creditType: string; balance: number; frozenBalance: number }[] };
  }>(`/credits/balances?clientId=${clientId}`);
  const row = res.body?.data?.balances?.find((b) => b.creditType === code);
  return { status: res.status, balance: row?.balance ?? 0, frozen: row?.frozenBalance ?? 0 };
}
