import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { projects } from "../projects/schema.js";

/** Interne notities en belnotities bij een klant (optioneel bij een project). Niet zichtbaar voor de klant. */
export const customerNotes = pgTable(
  "customer_notes",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    projectId: uuid("project_id").references(() => projects.id),
    /** "note" of "call". */
    kind: text("kind").notNull().default("note"),
    body: text("body").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_notes_customer_idx").on(t.customerId, t.createdAt)],
);
