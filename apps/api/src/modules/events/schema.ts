import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Outbox met domeingebeurtenissen (bv. "project.status_changed"). Wordt in dezelfde transactie
 * geschreven als de wijziging zelf. Een achtergrondproces verwerkt ze later tot automatiseringen:
 * e-mails, WhatsApp-berichten, taken, facturen. Zo gaat er nooit een trigger verloren.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [
    index("outbox_unprocessed_idx").on(t.id).where(sql`processed_at IS NULL`),
    index("outbox_aggregate_idx").on(t.aggregateType, t.aggregateId),
  ],
);

