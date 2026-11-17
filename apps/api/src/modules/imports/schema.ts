import { date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { projects } from "../projects/schema.js";
import { quotes } from "../quotes/schema.js";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { productGroups, products } from "../catalog/schema.js";
import { customers } from "../customers/schema.js";
import { files } from "../files/schema.js";
import { advisors } from "../organizations/schema.js";

/**
 * Offerte die buiten Gecko CRM is gemaakt (PDF van Greenteam, getekend door de klant) en is ingelezen.
 * Bewaard als origineel op de klantkaart; het inlezen maakt er een geaccepteerde Gecko-offerte met
 * project van (quoteId/projectId), zodat de klantreis start.
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
    /** De geaccepteerde Gecko-offerte die bij het inlezen is gemaakt. */
    quoteId: uuid("quote_id").references(() => quotes.id),
    projectId: uuid("project_id").references(() => projects.id),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("external_quotes_source_number_unique").on(t.source, t.externalNumber), index("external_quotes_customer_idx").on(t.customerId)],
);

/**
 * Onthoudt welk product bij een regel van een externe offerte hoort (per bron en productgroep), zodat
 * dezelfde omschrijving de volgende keer automatisch aan hetzelfde product wordt gekoppeld.
 */
export const productAliases = pgTable(
  "product_aliases",
  {
    id: id(),
    source: text("source").notNull(),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id),
    /** Genormaliseerde omschrijving (kleine letters, zonder accenten, enkele spaties). */
    descriptionKey: text("description_key").notNull(),
    /** Omschrijving zoals op de offerte. */
    description: text("description").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("product_aliases_unique").on(t.source, t.productGroupId, t.descriptionKey)],
);
