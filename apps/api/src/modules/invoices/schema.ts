import { sql } from "drizzle-orm";
import { bigint, date, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { products } from "../catalog/schema.js";
import { customers } from "../customers/schema.js";
import { projects } from "../projects/schema.js";
import { quotes } from "../quotes/schema.js";

/*
 * Verkoopfacturen.
 * - Een factuur krijgt pas een nummer bij het definitief maken; nummers lopen per jaar door zonder gaten.
 * - Een definitieve factuur is onveranderbaar (afgedwongen met een databasetrigger). Correctie = creditnota.
 * - Klant- en bedrijfsgegevens worden als momentopname op de factuur vastgelegd.
 */
export const invoiceType = pgEnum("invoice_type", ["deposit", "final", "credit"]);
export const invoiceStatus = pgEnum("invoice_status", ["draft", "open", "paid", "credited"]);
export const dunningStage = pgEnum("dunning_stage", ["none", "reminder", "formal_notice", "collection"]);

export const invoiceNumberSequences = pgTable(
  "invoice_number_sequences",
  {
    series: text("series").notNull(),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.series, t.year] })],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    /** Factuurnummer, bv. F2026-000001. Leeg zolang concept. */
    number: text("number"),
    type: invoiceType("type").notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    projectId: uuid("project_id").references(() => projects.id),
    quoteId: uuid("quote_id").references(() => quotes.id),
    /** Bij een creditnota: de gecrediteerde factuur. */
    creditedInvoiceId: uuid("credited_invoice_id"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
    vatCents: bigint("vat_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    /** Btw per tarief: [{rateBasisPoints, baseCents, vatCents}]. */
    vatBreakdown: jsonb("vat_breakdown").notNull().default(sql`'[]'::jsonb`),
    paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
    /** Betalingskenmerk voor overschrijvingen. */
    paymentReference: text("payment_reference"),
    customerSnapshot: jsonb("customer_snapshot"),
    companySnapshot: jsonb("company_snapshot"),
    note: text("note"),
    /** Hash van het token voor de openbare factuur-/betaalpagina. */
    publicTokenHash: text("public_token_hash"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    dunningStage: dunningStage("dunning_stage").notNull().default("none"),
    dunningStageAt: timestamp("dunning_stage_at", { withTimezone: true }),
    /** Aanmaningen tijdelijk stilzetten (bv. bij een klacht). */
    dunningPaused: text("dunning_paused_reason"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("invoices_number_unique").on(t.number),
    uniqueIndex("invoices_token_unique").on(t.publicTokenHash),
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_project_idx").on(t.projectId),
    index("invoices_status_idx").on(t.status, t.dueDate),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id),
    productCode: text("product_code"),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    vatRateBasisPoints: integer("vat_rate_basis_points").notNull(),
    lineTotalCents: bigint("line_total_cents", { mode: "number" }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

export const paymentMethod2 = pgEnum("invoice_payment_method", ["online", "bank_transfer", "warmtefonds", "other"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "paid", "failed", "expired", "canceled"]);

/** Betalingen en betaalverzoeken bij een factuur. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    method: paymentMethod2("method").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    /** "mollie", "test" of null bij handmatige registratie. */
    provider: text("provider"),
    providerPaymentId: text("provider_payment_id"),
    checkoutUrl: text("checkout_url"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    note: text("note"),
    registeredBy: uuid("registered_by").references(() => users.id),
    ...timestamps(),
  },
  (t) => [index("payments_invoice_idx").on(t.invoiceId), uniqueIndex("payments_provider_unique").on(t.provider, t.providerPaymentId)],
);

/** Elke herinnering/aanmaning die is verstuurd, met de berekende incassokosten. */
export const dunningEvents = pgTable(
  "dunning_events",
  {
    id: id(),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    stage: dunningStage("stage").notNull(),
    outstandingCents: bigint("outstanding_cents", { mode: "number" }).notNull(),
    collectionCostsCents: bigint("collection_costs_cents", { mode: "number" }),
    deadline: date("deadline"),
    emailId: uuid("email_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dunning_events_invoice_idx").on(t.invoiceId)],
);

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
