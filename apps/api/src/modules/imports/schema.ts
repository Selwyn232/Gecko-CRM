import { date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { productGroups } from "../catalog/schema.js";
import { customers } from "../customers/schema.js";
import { files } from "../files/schema.js";
import { advisors } from "../organizations/schema.js";

/**
 * Offerte die buiten Gecko CRM is gemaakt (nu: PDF van Greenteam) en is ingelezen.
 * Bewaard als document op de klantkaart, met de uitgelezen gegevens. Geen Gecko-offerte:
 * er hangen geen prijzen, project of facturen aan.
 */
export const externalQuotes = pgTable(
  "external_quotes",
  {
    id: id(),
    /** Herkomst, bv. "greenteam". */
    source: text("source").notNull(),
    /** Offertenummer van de bron (bv. 241308965). Per bron uniek: dubbel inlezen kan niet. */
    externalNumber: text("external_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    productGroupId: uuid("product_group_id").references(() => productGroups.id),
    advisorId: uuid("advisor_id").references(() => advisors.id),
    quoteDate: date("quote_date"),
    validUntil: date("valid_until"),
    /** Datum van ondertekening door de klant volgens de PDF (null = niet ondertekend). */
    signedDate: date("signed_date"),
    installerName: text("installer_name"),
    depositMethod: text("deposit_method"),
    /** [{ description, quantity }] zoals op de offerte. */
    lines: jsonb("lines").$type<{ description: string; quantity: number }[]>().notNull(),
    subtotalCents: integer("subtotal_cents"),
    vatCents: integer("vat_cents"),
    totalCents: integer("total_cents"),
    /** Alle uitgelezen gegevens (ook wat niet in kolommen staat), voor controle. */
    raw: jsonb("raw").notNull(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("external_quotes_source_number_unique").on(t.source, t.externalNumber), index("external_quotes_customer_idx").on(t.customerId)],
);
