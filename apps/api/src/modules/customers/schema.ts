import { bigint, boolean, index, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, timestamps } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { salesChannels } from "../catalog/schema.js";

/** Consument. Gecko is eigenaar van de klantrelatie. */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    /** Leesbaar klantnummer (K-000123), oplopend en nooit hergebruikt. */
    number: bigint("number", { mode: "number" }).notNull().generatedAlwaysAsIdentity().unique(),
    firstName: text("first_name"),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    /** Kanaal waarlangs de klant binnenkwam. */
    salesChannelId: uuid("sales_channel_id").references(() => salesChannels.id),
    /** Wie de klant aanmaakte (o.a. om adviseurs alleen hun eigen klanten te tonen). */
    createdBy: uuid("created_by"),
    notes: text("notes"),
    /**
     * Vaste klantspecialist (B81): gekoppeld bij de getekende order, tot en met de afgeronde installatie.
     * Daarna gaat de klant naar de afdeling Service (serviceSince gezet, specialist leeg).
     */
    /** WhatsApp-berichten aan deze klant (B83). Uit bij "STOP" van de klant of op verzoek. */
    whatsappEnabled: boolean("whatsapp_enabled").notNull().default(true),
    specialistUserId: uuid("specialist_user_id").references((): AnyPgColumn => users.id),
    specialistAssignedAt: timestamp("specialist_assigned_at", { withTimezone: true }),
    serviceSince: timestamp("service_since", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("customers_specialist_idx").on(t.specialistUserId),
    index("customers_email_idx").on(sql`lower(${t.email})`),
    index("customers_phone_idx").on(t.phone),
    index("customers_last_name_idx").on(sql`lower(${t.lastName})`),
  ],
);

/** Woning (adres) van een klant. Een klant kan meerdere woningen hebben. */
export const properties = pgTable(
  "properties",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    street: text("street").notNull(),
    houseNumber: text("house_number").notNull(),
    houseNumberAddition: text("house_number_addition"),
    /** Genormaliseerd: "1234AB". */
    postalCode: text("postal_code").notNull(),
    city: text("city").notNull(),
    country: text("country").notNull().default("NL"),
    /** BAG-verblijfsobject-id, voor latere koppeling met kadaster/energielabel. */
    bagId: text("bag_id"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [index("properties_customer_idx").on(t.customerId), index("properties_postal_idx").on(t.postalCode, t.houseNumber)],
);

export type Customer = typeof customers.$inferSelect;
export type Property = typeof properties.$inferSelect;
