import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { projects } from "../projects/schema.js";

/** Binnenkomende e-mail (via Mailgun), gekoppeld aan klant (op afzender) en project (op P-nummer in het onderwerp). */
export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: id(),
    messageId: text("message_id").unique(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    /** Tekst zonder geciteerde eerdere berichten (stripped-text), en de volledige tekst. */
    text: text("text").notNull(),
    fullText: text("full_text"),
    attachmentCount: text("attachment_count"),
    customerId: uuid("customer_id").references(() => customers.id),
    projectId: uuid("project_id").references(() => projects.id),
    /** new = nog niet behandeld, handled = afgehandeld. */
    status: text("status").notNull().default("new"),
    handledBy: uuid("handled_by").references(() => users.id),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("inbound_emails_status_idx").on(t.status, t.receivedAt), index("inbound_emails_customer_idx").on(t.customerId)],
);
