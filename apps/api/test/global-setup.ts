import pg from "pg";
import { runMigrations } from "../src/db/migrate.js";

/** Eén keer per testrun: schone testdatabase met alle migraties. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://gecko:gecko@localhost:5432/gecko_test";
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();
  await runMigrations(url);
}
