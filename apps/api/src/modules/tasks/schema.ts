import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { projects } from "../projects/schema.js";

/** Taken voor medewerkers, optioneel bij een klant of project. */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    customerId: uuid("customer_id").references(() => customers.id),
    projectId: uuid("project_id").references(() => projects.id),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    dueDate: date("due_date"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneBy: uuid("done_by").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_assignee_idx").on(t.assigneeUserId, t.doneAt), index("tasks_customer_idx").on(t.customerId)],
);

/** Meldingen in het CRM (belletje), per gebruiker. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    body: text("body"),
    /** Pad in het CRM om naartoe te gaan. */
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Zelfde sleutel = niet nogmaals melden (bv. bij herhaalde verwerking van een gebeurtenis). */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt), uniqueIndex("notifications_dedupe_unique").on(t.userId, t.dedupeKey)],
);
