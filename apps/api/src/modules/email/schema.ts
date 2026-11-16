import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { customers } from "../customers/schema.js";

/**
 * Elke uitgaande e-mail, ook als er (nog) niets echt verstuurd wordt. Zo is altijd na te gaan
 * wat een klant heeft ontvangen, en vormt dit straks de basis van de communicatietijdlijn.
 */
export const emailStatus = pgEnum("email_status", ["queued", "sent", "failed", "not_sent"]);

export const outboundEmails = pgTable(
  "outbound_emails",
  {
    id: id(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    text: text("text").notNull(),
    /** Soort bericht, bv. "quote.link" of "quote.code". */
    template: text("template").notNull(),
    customerId: uuid("customer_id").references(() => customers.id),
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    status: emailStatus("status").notNull().default("queued"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    /** Voorkomt dubbel versturen bij automatische berichten (bv. herinnering per afspraak). */
    dedupeKey: text("dedupe_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("outbound_emails_customer_idx").on(t.customerId), index("outbound_emails_related_idx").on(t.relatedType, t.relatedId)],
);
