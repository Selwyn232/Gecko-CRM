/**
 * Maakt de eerste beheerder aan. Gebruik:
 *   pnpm --filter @gecko/api create-admin <email> "<naam>"
 * Het wachtwoord wordt gevraagd via de omgevingsvariabele ADMIN_PASSWORD (niet als argument,
 * zodat het niet in de shell-geschiedenis belandt).
 */
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { systemActor } from "../lib/context.js";
import { ADMIN_ROLE_KEY } from "../modules/auth/permissions.js";
import { roles } from "../modules/auth/schema.js";
import { organizations } from "../modules/organizations/schema.js";
import { createUser } from "../modules/users/service.js";

const [email, name] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
if (!email || !name || !password) {
  console.error('Gebruik: ADMIN_PASSWORD=... pnpm create-admin <email> "<naam>"');
  process.exit(1);
}

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
try {
  const [gecko] = await db.select().from(organizations).where(eq(organizations.type, "gecko")).limit(1);
  const [admin] = await db.select().from(roles).where(eq(roles.key, ADMIN_ROLE_KEY));
  if (!gecko || !admin) throw new Error("Draai eerst: pnpm db:seed");
  const user = await createUser(db, systemActor(), {
    organizationId: gecko.id,
    email,
    name,
    password,
    roleIds: [admin.id],
    mustChangePassword: false,
  });
  console.log(`Beheerder aangemaakt: ${user.email}. Stel bij eerste login 2FA in.`);
} finally {
  await pool.end();
}
