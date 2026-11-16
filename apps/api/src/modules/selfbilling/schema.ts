import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { organizations } from "../organizations/schema.js";
import { partnerPenalties } from "../planning/schema.js";
import { projects } from "../projects/schema.js";
import { quotes } from "../quotes/schema.js";

/**
 * Selfbilling: inkoopfacturen die Gecko namens een partner opmaakt (zelffacturering, art. 35a Wet OB).
 * - Greenteam (verkooppartner): fee over de orderwaarde ex btw, per project en adviseur, na betaalde aanbetaling
 * - installatiepartner: vaste partnertarieven + meerwerk − boetes, na betaalde eindfactuur
 * Per partner een eigen, doorlopende nummerreeks. Definitief = onveranderbaar (databasetrigger).
 */
export const selfBillingStatus = pgEnum("self_billing_status", ["draft", "final", "paid"]);
export const selfBillingKind = pgEnum("self_billing_kind", ["sales_fee", "installation"]);
export const selfBillingLineKind = pgEnum("self_billing_line_kind", ["fee", "installation", "extra_work", "penalty", "correction"]);

export const selfBillingSequences = pgTable(
  "self_billing_sequences",
  {
    partnerOrganizationId: uuid("partner_organization_id")
      .notNull()
      .references(() => organizations.id),
    year: integer("year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.partnerOrganizationId, t.year] })],
);

export const selfBillingInvoices = pgTable(
  "self_billing_invoices",
  {
    id: id(),
    partnerOrganizationId: uuid("partner_organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: selfBillingKind("kind").notNull(),
    status: selfBillingStatus("status").notNull().default("draft"),
    number: text("number").unique(),
    invoiceDate: date("invoice_date"),
    /** "normal" = btw volgens tarief; "reverse_charge" = btw verlegd (onderaanneming). */
    vatMode: text("vat_mode").notNull(),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    vatCents: integer("vat_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    vatBreakdown: jsonb("vat_breakdown").$type<{ rateBasisPoints: number; baseCents: number; vatCents: number }[]>().notNull().default(sql`'[]'::jsonb`),
    partnerSnapshot: jsonb("partner_snapshot"),
    companySnapshot: jsonb("company_snapshot"),
    note: text("note"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: date("paid_at"),
    /**
     * Akkoord van de ontvanger (verplicht vóór uitbetaling). Via de link in de e-mail of het partnerportaal.
     * pending = wacht op akkoord, approved = akkoord, disputed = niet akkoord (met reden).
     */
    approvalStatus: text("approval_status"),
    approvalTokenHash: text("approval_token_hash").unique(),
    /** Vingerafdruk van de factuur bij definitief maken; bij akkoord gecontroleerd. */
    contentHash: text("content_hash"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByName: text("approved_by_name"),
    approvalEvidence: jsonb("approval_evidence"),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    disputeReason: text("dispute_reason"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps(),
  },
  (t) => [index("self_billing_invoices_partner_idx").on(t.partnerOrganizationId, t.status)],
);

export const selfBillingLines = pgTable(
  "self_billing_lines",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => selfBillingInvoices.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    kind: selfBillingLineKind("kind").notNull(),
    projectId: uuid("project_id").references(() => projects.id),
    quoteId: uuid("quote_id").references(() => quotes.id),
    penaltyId: uuid("penalty_id").references(() => partnerPenalties.id),
    advisorName: text("advisor_name"),
    description: text("description").notNull(),
    /** Grondslag voor de fee (orderwaarde ex btw) en het percentage, ter specificatie. */
    basisCents: integer("basis_cents"),
    feeBasisPoints: integer("fee_basis_points"),
    amountCents: integer("amount_cents").notNull(),
    vatRateBasisPoints: integer("vat_rate_basis_points").notNull(),
  },
  (t) => [
    index("self_billing_lines_invoice_idx").on(t.invoiceId),
    // Elke bron wordt maar één keer uitbetaald.
    uniqueIndex("self_billing_lines_fee_unique").on(t.quoteId).where(sql`kind = 'fee'`),
    uniqueIndex("self_billing_lines_extra_unique").on(t.quoteId).where(sql`kind = 'extra_work'`),
    uniqueIndex("self_billing_lines_installation_unique").on(t.projectId).where(sql`kind = 'installation'`),
    uniqueIndex("self_billing_lines_penalty_unique").on(t.penaltyId).where(sql`kind = 'penalty'`),
  ],
);

export type SelfBillingInvoice = typeof selfBillingInvoices.$inferSelect;
export type SelfBillingLine = typeof selfBillingLines.$inferSelect;
