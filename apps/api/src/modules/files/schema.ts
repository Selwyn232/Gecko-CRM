import { customType, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";
import { users } from "../auth/schema.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * Bestanden (foto's, handtekeningen). Opslag achter een abstractie (zie storage.ts):
 * nu in de database, later object storage (S3/R2) zonder dat de rest verandert.
 * Bij grote aantallen foto's is object storage nodig; zie docs/07.
 */
export const files = pgTable(
  "files",
  {
    id: id(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** "db" of later "s3". */
    storage: text("storage").notNull().default("db"),
    data: bytea("data"),
    storageKey: text("storage_key"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_owner_idx").on(t.ownerType, t.ownerId)],
);
