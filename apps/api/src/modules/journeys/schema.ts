import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { productGroups, salesChannels } from "../catalog/schema.js";

/**
 * Klantreis per productgroep: welke statussen een project kan hebben en welke overgangen zijn toegestaan.
 * Volledig door beheerders in te stellen. Statussen die in gebruik zijn, kunnen alleen worden gedeactiveerd.
 *
 * Een klantreis = productgroep + verkoopkanaal (B80). `sales_channel_id` leeg = de standaardklantreis van de
 * productgroep; gevuld = een eigen klantreis voor dat kanaal, die voor projecten van dat kanaal de standaard vervangt.
 */
export const journeyStatuses = pgTable(
  "journey_statuses",
  {
    id: id(),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id),
    /** Leeg = standaardklantreis; gevuld = eigen klantreis van dit verkoopkanaal. */
    salesChannelId: uuid("sales_channel_id").references(() => salesChannels.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Fase voor groepering in overzichten (bv. "Schouw", "Installatie"). */
    phase: text("phase").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Startstatus voor nieuwe projecten. Precies één per klantreis. */
    isInitial: boolean("is_initial").notNull().default(false),
    /** Eindstatus: project is afgerond of geannuleerd. */
    isFinal: boolean("is_final").notNull().default(false),
    color: text("color").notNull().default("gray"),
    /** Automatisch te maken en versturen factuur bij het bereiken van deze status. */
    invoiceTrigger: text("invoice_trigger"),
    /**
     * Automatisch naar deze status als een van deze gebeurtenissen optreedt én de overgang vanuit de huidige status
     * is toegestaan. Bv. "survey.scheduled", "installation.report_submitted". Zie journeys/events.ts.
     */
    autoOnEvents: text("auto_on_events").array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    // Uniek per klantreis; de standaardklantreis (kanaal leeg) telt als één klantreis.
    uniqueIndex("journey_statuses_key_unique").on(t.productGroupId, sql`coalesce(${t.salesChannelId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key),
    uniqueIndex("journey_statuses_one_initial").on(t.productGroupId, sql`coalesce(${t.salesChannelId}, '00000000-0000-0000-0000-000000000000'::uuid)`).where(sql`is_initial`),
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
