import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { journeyStatuses } from "../journeys/schema.js";

/**
 * Klantberichten (nu e-mail, later ook WhatsApp). Twee soorten:
 * - per status in de klantreis (journey_status_id): verstuurd zodra een project die status bereikt;
 * - vaste momenten (key), bv. "appointment.scheduled.survey" of "appointment.reminder.installation".
 * Tekst met invulvelden zoals {voornaam}; zie messages/templates.ts.
 */
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: id(),
    key: text("key"),
    journeyStatusId: uuid("journey_status_id").references(() => journeyStatuses.id, { onDelete: "cascade" }),
    channel: text("channel").notNull().default("email"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("message_templates_key_unique").on(t.key, t.channel),
    uniqueIndex("message_templates_status_unique").on(t.journeyStatusId, t.channel),
    check("message_templates_one_target", sql`(${t.key} IS NULL) <> (${t.journeyStatusId} IS NULL)`),
  ],
);

export type MessageTemplate = typeof messageTemplates.$inferSelect;
