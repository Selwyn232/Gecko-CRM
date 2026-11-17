import { bigint, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { productGroups, products, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { advisors, organizations } from "../organizations/schema.js";
import { projects } from "../projects/schema.js";

/*
 * Offerte op naam van Gecko BV, voor één productgroep op één woning.
 *
 * - concept:     regels en prijzen kunnen wijzigen; prijzen komen live uit de prijslijst van het kanaal
 * - verstuurd:   prijzen, btw en kostprijzen zijn vastgezet; alleen nog accepteren/afwijzen/nieuwe versie
 * - geaccepteerd: project is aangemaakt; de offerte is onveranderbaar
 * - afgewezen / vervangen (door een nieuwe versie)
 * "Verlopen" is geen opgeslagen status maar volgt uit valid_until.
 */
export const quoteStatus = pgEnum("quote_status", ["draft", "sent", "accepted", "rejected", "superseded"]);
/** Hoofdofferte (maakt bij akkoord het project) of meerwerk-offerte (hoort bij een bestaand project). */
export const quoteKind = pgEnum("quote_kind", ["main", "extra_work"]);
/** "sales_partner" = getekend bij de verkooppartner (bv. Greenteam-offerte ingelezen). */
export const acceptanceMethod = pgEnum("acceptance_method", ["signed_paper", "signed_digital", "email", "verbal_confirmed", "sales_partner"]);

export const quotes = pgTable(
  "quotes",
  {
    id: id(),
    /** Offertenummer (O-000123). Een nieuwe versie krijgt een nieuw nummer en verwijst naar de vorige. */
    number: bigint("number", { mode: "number" }).notNull().generatedAlwaysAsIdentity().unique(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    propertyId: uuid("property_id").notNull().references(() => properties.id),
    productGroupId: uuid("product_group_id").notNull().references(() => productGroups.id),
    salesChannelId: uuid("sales_channel_id").notNull().references(() => salesChannels.id),
    advisorId: uuid("advisor_id").references(() => advisors.id),
    /** Beoogde installatiepartner; bepaalt het partnertarief in de kostprijs. */
    installationPartnerId: uuid("installation_partner_id").references(() => organizations.id),
    kind: quoteKind("kind").notNull().default("main"),
    status: quoteStatus("status").notNull().default("draft"),
    /** Datum waarop prijzen zijn bepaald (bij versturen vastgezet). */
    priceDate: date("price_date"),
    validUntil: date("valid_until"),
    /** Fee van het kanaal op het moment van versturen (basispunten). */
    feeBasisPoints: integer("fee_basis_points"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByName: text("accepted_by_name"),
    acceptanceMethod: acceptanceMethod("acceptance_method"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    supersedesQuoteId: uuid("supersedes_quote_id"),
    projectId: uuid("project_id").references(() => projects.id),
    /** SHA-256 van de inhoud bij definitief maken; bewijst later welke offerte precies is geaccepteerd. */
    contentHash: text("content_hash"),
    /** Bewijs van digitaal akkoord: e-mailadres, verificatie, IP, apparaat, tijdstip, inhoud-hash. */
    acceptanceEvidence: jsonb("acceptance_evidence"),
    /** Tekst op de offerte voor de klant. */
    customerNote: text("customer_note"),
    /** Interne notitie, niet op de offerte. */
    internalNote: text("internal_note"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("quotes_customer_idx").on(t.customerId),
    index("quotes_status_idx").on(t.status),
    index("quotes_project_idx").on(t.projectId),
  ],
);

export const quoteLines = pgTable(
  "quote_lines",
  {
    id: id(),
    quoteId: uuid("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id),
    /** Omschrijving zoals op de offerte (standaard de productnaam). */
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    /** Snapshot: verkoopprijs per eenheid ex btw. */
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    /** Snapshot: btw-tarief in basispunten. */
    vatRateBasisPoints: integer("vat_rate_basis_points").notNull(),
    /** Snapshot: kostprijs per eenheid (voorcalculatie). Null = (deels) onbekend. */
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("quote_lines_quote_idx").on(t.quoteId)],
);

export type Quote = typeof quotes.$inferSelect;
export type QuoteLine = typeof quoteLines.$inferSelect;

/**
 * Persoonlijke link waarmee de klant een offerte bekijkt en digitaal accepteert.
 * Alleen de hash van het token staat in de database.
 */
export const quoteLinks = pgTable(
  "quote_links",
  {
    id: id(),
    quoteId: uuid("quote_id").notNull().references(() => quotes.id),
    tokenHash: text("token_hash").notNull().unique(),
    /** Het adres waarheen link en verificatiecodes gaan. */
    email: text("email").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  },
  (t) => [index("quote_links_quote_idx").on(t.quoteId)],
);

/** Eenmalige verificatiecode (per e-mail) voordat de klant akkoord kan geven. */
export const quoteLinkCodes = pgTable(
  "quote_link_codes",
  {
    id: id(),
    linkId: uuid("link_id").notNull().references(() => quoteLinks.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quote_link_codes_link_idx").on(t.linkId)],
);
