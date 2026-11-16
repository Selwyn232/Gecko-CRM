import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Standaardkolommen. Elke tabel krijgt een UUID en tijdstempels, zodat records altijd traceerbaar zijn. */
export const id = () => uuid("id").primaryKey().defaultRandom();

export const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
