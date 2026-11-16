/**
 * Draait vóór het starten van de server (zie startcommando op Render):
 * 1. databasemigraties
 * 2. basisgegevens (idempotent)
 * 3. optioneel voorbeelddata (SEED_DEMO=true)
 * 4. eerste beheerder, alleen als er nog géén gebruikers zijn
 *    (BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD). Verwijder die variabelen na de eerste login.
 */
import { count, eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { seedDemo } from "../db/seed-demo.js";
import { systemActor } from "../lib/context.js";
import { ADMIN_ROLE_KEY } from "../modules/auth/permissions.js";
import { roles, users } from "../modules/auth/schema.js";
import { organizations } from "../modules/organizations/schema.js";
import { createUser } from "../modules/users/service.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
console.log("Migraties uitgevoerd");

const { db, pool } = createDb(config.DATABASE_URL);
try {
  await seed(db);
  if (process.env.SEED_DEMO === "true" && (await seedDemo(db))) console.log("Voorbeelddata aangemaakt");

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users);
  if (n === 0 && email && password) {
    const [gecko] = await db.select().from(organizations).where(eq(organizations.type, "gecko")).limit(1);
    const [admin] = await db.select().from(roles).where(eq(roles.key, ADMIN_ROLE_KEY));
    await createUser(db, systemActor(), { organizationId: gecko!.id, email, name: "Beheerder", password, roleIds: [admin!.id] });
    console.log(`Eerste beheerder aangemaakt: ${email}`);
  }
} finally {
  await pool.end();
}
