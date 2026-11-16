import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { organizations } from "../organizations/schema.js";
import { users } from "../auth/schema.js";

/*
 * Productcatalogus en prijzen.
 *
 * Prijsregels:
 * - Alle bedragen in centen, exclusief btw (integer, nooit floating point).
 * - Prijzen worden nooit overschreven. Een wijziging is een nieuwe versie met een ingangsdatum
 *   (`valid_from`). De geldende prijs op datum D is de versie met de hoogste valid_from <= D.
 * - Versies die al zijn ingegaan zijn onveranderbaar; alleen toekomstige versies mogen worden verwijderd.
 *   Zo blijft elke historische offerte, factuur en calculatie reproduceerbaar.
 */

export const productType = pgEnum("product_type", [
  "package", // pakket zoals de klant het koopt
  "component", // fysiek onderdeel (omvormer, batterijmodule, montagemateriaal)
  "labor", // arbeid
  "extra_work", // vast meerwerkproduct
  "service", // dienst (onderhoud, schouw)
]);

/** Btw-codes (bv. "hoog", "laag", "nul"). Het percentage per code heeft versies, zodat wetswijzigingen geen code vragen. */
export const vatCodes = pgTable("vat_codes", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  ...timestamps(),
});

export const vatRates = pgTable(
  "vat_rates",
  {
    id: id(),
    vatCode: text("vat_code")
      .notNull()
      .references(() => vatCodes.code),
    /** In basispunten: 2100 = 21,00%. */
    rateBasisPoints: integer("rate_basis_points").notNull(),
    validFrom: date("valid_from").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => [
    unique("vat_rates_code_from_unique").on(t.vatCode, t.validFrom),
    check("vat_rates_rate_range", sql`${t.rateBasisPoints} >= 0 AND ${t.rateBasisPoints} <= 10000`),
  ],
);

export const productGroups = pgTable("product_groups", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps(),
});

/** Verkoopkanaal: Greenteam, web-only, binnendienst. Bepaalt prijslijst en toegestane productgroepen. */
export const salesChannels = pgTable("sales_channels", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  /** De verkooppartner achter dit kanaal (bv. Greenteam), voor fee en selfbilling. Leeg voor eigen kanalen. */
  salesPartnerOrganizationId: uuid("sales_partner_organization_id").references(() => organizations.id),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps(),
});

export const salesChannelProductGroups = pgTable(
  "sales_channel_product_groups",
  {
    salesChannelId: uuid("sales_channel_id")
      .notNull()
      .references(() => salesChannels.id, { onDelete: "cascade" }),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.salesChannelId, t.productGroupId] })],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    /** Productcode zoals op offerte, factuur en in Exact. Uniek en na gebruik niet meer te wijzigen. */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id),
    type: productType("type").notNull(),
    unit: text("unit").notNull().default("stuk"),
    vatCode: text("vat_code")
      .notNull()
      .references(() => vatCodes.code),
    defaultSupplierOrganizationId: uuid("default_supplier_organization_id").references(() => organizations.id),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("products_group_idx").on(t.productGroupId), index("products_type_idx").on(t.type)],
);

/** Stuklijst: waaruit een pakket intern bestaat. Basis voor de voorcalculatie. */
export const bomItems = pgTable(
  "bom_items",
  {
    id: id(),
    parentProductId: uuid("parent_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    componentProductId: uuid("component_product_id")
      .notNull()
      .references(() => products.id),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("bom_items_parent_component_unique").on(t.parentProductId, t.componentProductId),
    check("bom_items_not_self", sql`${t.parentProductId} <> ${t.componentProductId}`),
    check("bom_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);

const priceColumns = () => ({
  id: id(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  priceCents: bigint("price_cents", { mode: "number" }).notNull(),
  validFrom: date("valid_from").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => users.id),
});

/** Verkoopprijs per kanaal. */
export const salesPrices = pgTable(
  "sales_prices",
  {
    ...priceColumns(),
    salesChannelId: uuid("sales_channel_id")
      .notNull()
      .references(() => salesChannels.id),
  },
  (t) => [
    unique("sales_prices_version_unique").on(t.productId, t.salesChannelId, t.validFrom),
    check("sales_prices_non_negative", sql`${t.priceCents} >= 0`),
  ],
);

/** Inkoopprijs per leverancier (bv. OSW). */
export const purchasePrices = pgTable(
  "purchase_prices",
  {
    ...priceColumns(),
    supplierOrganizationId: uuid("supplier_organization_id")
      .notNull()
      .references(() => organizations.id),
  },
  (t) => [
    unique("purchase_prices_version_unique").on(t.productId, t.supplierOrganizationId, t.validFrom),
    check("purchase_prices_non_negative", sql`${t.priceCents} >= 0`),
  ],
);

/** Vaste prijs die een installatiepartner krijgt voor een pakket, arbeid of meerwerk. */
export const partnerRates = pgTable(
  "partner_rates",
  {
    ...priceColumns(),
    partnerOrganizationId: uuid("partner_organization_id")
      .notNull()
      .references(() => organizations.id),
  },
  (t) => [
    unique("partner_rates_version_unique").on(t.productId, t.partnerOrganizationId, t.validFrom),
    check("partner_rates_non_negative", sql`${t.priceCents} >= 0`),
  ],
);

export type Product = typeof products.$inferSelect;
export type ProductGroup = typeof productGroups.$inferSelect;
export type SalesChannel = typeof salesChannels.$inferSelect;
