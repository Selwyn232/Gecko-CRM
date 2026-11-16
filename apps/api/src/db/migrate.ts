import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(databaseUrl: string) {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ontbreekt");
  await runMigrations(url);
  console.log("Migraties uitgevoerd");
}
