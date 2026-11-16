import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { productGroups } from "../catalog/schema.js";

/**
 * Klantreis per productgroep: welke statussen een project kan hebben en welke overgangen zijn toegestaan.
 * Volledig door beheerders in te stellen. Statussen die in gebruik zijn, kunnen alleen worden gedeactiveerd.
 */
export const journeyStatuses = pgTable(
  "journey_statuses",
  {
    id: id(),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Fase voor groepering in overzichten (bv. "Schouw", "Installatie"). */
    phase: text("phase").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Startstatus voor nieuwe projecten. Precies één per productgroep. */
    isInitial: boolean("is_initial").notNull().default(false),
    /** Eindstatus: project is afgerond of geannuleerd. */
    isFinal: boolean("is_final").notNull().default(false),
    color: text("color").notNull().default("gray"),
    /** Automatisch te maken en versturen factuur bij het bereiken van deze status. */
    invoiceTrigger: text("invoice_trigger"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("journey_statuses_key_unique").on(t.productGroupId, t.key),
    uniqueIndex("journey_statuses_one_initial").on(t.productGroupId).where(sql`is_initial`),
    index("journey_statuses_group_idx").on(t.productGroupId),
  ],
);

export const journeyTransitions = pgTable(
  "journey_transitions",
  {
    fromStatusId: uuid("from_status_id")
      .notNull()
      .references(() => journeyStatuses.id, { onDelete: "cascade" }),
    toStatusId: uuid("to_status_id")
      .notNull()
      .references(() => journeyStatuses.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.fromStatusId, t.toStatusId] })],
);

export type JourneyStatus = typeof journeyStatuses.$inferSelect;
