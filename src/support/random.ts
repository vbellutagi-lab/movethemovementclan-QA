import { randomUUID } from "node:crypto";

export function uniqueEmail(prefix: string): string {
  return `${prefix}+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@move-qa.test`;
}

export function idempotencyKey(prefix: string): string {
  return `qa-${prefix}-${randomUUID()}`;
}

/** A syntactically valid UUID that (with overwhelming probability) refers to no row. */
export function nonExistentUuid(): string {
  return "00000000-0000-4000-8000-000000000000";
}

export { randomUUID };
