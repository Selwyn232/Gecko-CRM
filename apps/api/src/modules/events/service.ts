import type { DbOrTx } from "../../db/client.js";
import { outboxEvents } from "./schema.js";

/** Alle gebeurtenistypen. Nieuwe types hier toevoegen, zodat automatiseringen weten waarop ze kunnen reageren. */
export type DomainEventType =
  | "customer.created"
  | "project.created"
  | "project.status_changed"
  | "quote.sent"
  | "quote.accepted"
  | "quote.rejected"
  | "invoice.sent"
  | "invoice.paid"
  | "invoice.collection";

export async function emitEvent(
  tx: DbOrTx,
  type: DomainEventType,
  aggregate: { type: string; id: string },
  payload: Record<string, unknown>,
) {
  await tx.insert(outboxEvents).values({ type, aggregateType: aggregate.type, aggregateId: aggregate.id, payload });
}
