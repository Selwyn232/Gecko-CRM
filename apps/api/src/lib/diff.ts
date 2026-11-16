/** Velden die nooit in het logboek mogen verschijnen. */
const REDACTED_FIELDS = new Set(["passwordHash", "totpSecretEncrypted", "tokenHash", "codeHash"]);

export type Changes = Record<string, { from: unknown; to: unknown }>;

const normalize = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

/** Berekent welke velden zijn gewijzigd tussen twee versies van een record, voor het audit log. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Changes {
  const changes: Changes = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (key === "updatedAt" || key === "createdAt") continue;
    const from = normalize(before?.[key] ?? null);
    const to = normalize(after?.[key] ?? null);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes[key] = REDACTED_FIELDS.has(key) ? { from: "[verborgen]", to: "[verborgen]" } : { from, to };
  }
  return changes;
}
