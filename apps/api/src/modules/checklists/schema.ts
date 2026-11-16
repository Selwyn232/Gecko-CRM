import { boolean, index, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { productGroups } from "../catalog/schema.js";

/**
 * Checklists voor het schouw- en opleverrapport, per productgroep en soort afspraak. Door beheerders in te stellen.
 * Rapporten bewaren de afgevinkte punten op tekst (label), zodat wijzigen van de lijst oude rapporten niet raakt.
 */
export const checklistItems = pgTable(
  "checklist_items",
  {
    id: id(),
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id, { onDelete: "cascade" }),
    /** "survey" (schouw) of "installation" (oplevering). */
    type: text("type").notNull(),
    label: text("label").notNull(),
    /** Verplicht af te vinken bij een positief rapport. */
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("checklist_items_group_idx").on(t.productGroupId, t.type)],
);

/** Overige eisen per productgroep en soort, zoals het minimum aantal foto's. */
export const checklistSettings = pgTable(
  "checklist_settings",
  {
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    minPhotos: integer("min_photos").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productGroupId, t.type] })],
);
