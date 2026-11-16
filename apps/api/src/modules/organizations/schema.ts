import { boolean, index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";

/**
 * Een organisatie is elke partij die met het systeem werkt: Gecko zelf, verkooppartners (Greenteam),
 * installatiepartners en leveranciers (OSW). Gebruikers horen altijd bij één organisatie; daarop wordt
 * later ook de data afgeschermd.
 */
export const organizationType = pgEnum("organization_type", [
  "gecko",
  "sales_partner",
  "installation_partner",
  "supplier",
]);

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    type: organizationType("type").notNull(),
    kvkNumber: text("kvk_number"),
    vatNumber: text("vat_number"),
    email: text("email"),
    phone: text("phone"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("organizations_type_idx").on(t.type)],
);

/** Adviseur van een verkooppartner (bv. Greenteam). Per offerte vastgelegd voor de fee-specificatie. */
export const advisors = pgTable(
  "advisors",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("advisors_org_idx").on(t.organizationId)],
);

export type Organization = typeof organizations.$inferSelect;
export type Advisor = typeof advisors.$inferSelect;
