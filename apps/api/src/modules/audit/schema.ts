import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Onveranderbaar logboek van alle wijzigingen. Een databasetrigger (zie migratie) blokkeert
 * UPDATE en DELETE, zodat ook een programmeerfout de historie niet kan aantasten.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null bij systeemacties (automatiseringen, migraties). Bewust geen foreign key: het log overleeft alles. */
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    changes: jsonb("changes"),
    metadata: jsonb("metadata"),
    requestId: text("request_id"),
    ip: text("ip"),
  },
  (t) => [
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_actor_idx").on(t.actorUserId),
    index("audit_log_occurred_idx").on(t.occurredAt),
  ],
);

export type AuditEntry = typeof auditLog.$inferSelect;
