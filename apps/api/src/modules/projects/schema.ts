import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { productGroups, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { journeyStatuses } from "../journeys/schema.js";
import { organizations } from "../organizations/schema.js";

export const paymentMethod = pgEnum("payment_method", ["direct", "warmtefonds"]);

/**
 * Project = één productgroep op één woning, met een eigen statusflow, partner, facturen en calculatie.
 * Koopt een klant meerdere productgroepen, dan zijn dat meerdere projecten.
 */
export const projects = pgTable(
  "projects",
  {
    id: id(),
    /** Leesbaar projectnummer (P-000123). */
    number: bigint("number", { mode: "number" }).notNull().generatedAlwaysAsIdentity().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id),
    salesChannelId: uuid("sales_channel_id")
      .notNull()
      .references(() => salesChannels.id),
    statusId: uuid("status_id")
      .notNull()
      .references(() => journeyStatuses.id),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    installationPartnerId: uuid("installation_partner_id").references(() => organizations.id),
    paymentMethod: paymentMethod("payment_method").notNull().default("direct"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [
    index("projects_customer_idx").on(t.customerId),
    index("projects_status_idx").on(t.statusId),
    index("projects_group_idx").on(t.productGroupId),
    index("projects_partner_idx").on(t.installationPartnerId),
  ],
);

/** Elke statuswissel, met tijd en veroorzaker. Basis voor doorlooptijden per fase. */
export const projectStatusHistory = pgTable(
  "project_status_history",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    fromStatusId: uuid("from_status_id").references(() => journeyStatuses.id),
    toStatusId: uuid("to_status_id")
      .notNull()
      .references(() => journeyStatuses.id),
    changedBy: uuid("changed_by").references(() => users.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    note: text("note"),
  },
  (t) => [index("project_status_history_project_idx").on(t.projectId, t.changedAt)],
);

export type Project = typeof projects.$inferSelect;
