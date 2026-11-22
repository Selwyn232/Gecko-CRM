import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";

/**
 * WhatsApp-berichten (B83), in en uit, via de Meta WhatsApp Cloud API.
 * Eén gesprek per klant; het CRM koppelt binnenkomende berichten op telefoonnummer.
 */
export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: id(),
    customerId: uuid("customer_id").references(() => customers.id),
    /** in = van de klant, out = van Gecko. */
    direction: text("direction").notNull(),
    /** Telefoonnummer van de klant zonder + (zoals WhatsApp het noemt: wa_id), bv. 31612345678. */
    waId: text("wa_id").notNull(),
    /** text, template, image, document, audio, video, location, button, other. */
    kind: text("kind").notNull().default("text"),
    body: text("body").notNull().default(""),
    /** Bij een sjabloon: de naam bij Meta. */
    templateName: text("template_name"),
    /** Bij media van de klant: id bij Meta (ophalen kan met de toegangssleutel). */
    mediaId: text("media_id"),
    /** received | queued | sent | delivered | read | failed | not_sent */
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id").unique(),
    error: text("error"),
    /** Welke e-mail dit bericht spiegelt (alles wat per e-mail gaat, gaat ook via WhatsApp). */
    emailId: uuid("email_id"),
    sentBy: uuid("sent_by").references(() => users.id),
    /** Binnenkomend bericht gelezen door een medewerker. */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("whatsapp_customer_idx").on(t.customerId, t.createdAt), index("whatsapp_wa_idx").on(t.waId, t.createdAt)],
);

export type WhatsappMessage = typeof whatsappMessages.$inferSelect;
