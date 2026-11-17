/**
 * Draait vóór het starten van de server (zie startcommando op Render):
 * 1. databasemigraties
 * 2. basisgegevens (idempotent)
 * 3. optioneel voorbeelddata (SEED_DEMO=true)
 * 4. eerste beheerder, alleen als er nog géén gebruikers zijn
 *    (BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD). Verwijder die variabelen na de eerste login.
 * 6. optioneel eenmalig wachtwoord herstellen: RESET_USER_PASSWORD="gebruikersnaam:wachtwoord".
 *    Zet het wachtwoord zonder wachtwoordbeleid (bewuste uitzondering door de eigenaar), zonder
 *    verplichte wijziging en zonder 2FA-plicht; heft blokkades op en beëindigt sessies. Verwijder de variabele daarna.
 * 5. optioneel extra beheerders op gebruikersnaam, zonder 2FA en met verplicht nieuw wachtwoord bij
 *    eerste login: BOOTSTRAP_USERS="naam:startwachtwoord,naam2:startwachtwoord2".
 *    Bestaat de gebruikersnaam al, dan wordt die overgeslagen. Verwijder de variabele daarna.
 */
import { count, eq, sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { seedDemo } from "../db/seed-demo.js";
import { systemActor } from "../lib/context.js";
import { ADMIN_ROLE_KEY } from "../modules/auth/permissions.js";
import { roles, sessions, users } from "../modules/auth/schema.js";
import { hashPassword } from "../modules/auth/password.js";
import { recordAudit } from "../modules/audit/service.js";
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

  const extra = process.env.BOOTSTRAP_USERS?.split(",").map((e) => e.trim()).filter(Boolean) ?? [];
  if (extra.length) {
    const [gecko] = await db.select().from(organizations).where(eq(organizations.type, "gecko")).limit(1);
    const [admin] = await db.select().from(roles).where(eq(roles.key, ADMIN_ROLE_KEY));
    for (const entry of extra) {
      // Formaat: e-mailadres:startwachtwoord (de inlognaam is altijd het e-mailadres).
      const [email, pw] = entry.split(":");
      if (!email || !pw) continue;
      if (!email.includes("@")) {
        console.log(`BOOTSTRAP_USERS: "${email}" is geen e-mailadres en wordt overgeslagen (gebruik e-mailadres:wachtwoord)`);
        continue;
      }
      const [exists] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase()));
      if (exists) continue;
      const local = email.split("@")[0]!;
      const displayName = local.charAt(0).toUpperCase() + local.slice(1);
      await createUser(db, systemActor(), {
        organizationId: gecko!.id,
        email,
        name: displayName,
        password: pw,
        roleIds: [admin!.id],
        mfaRequired: false,
        mustChangePassword: true,
      });
      console.log(`Gebruiker aangemaakt: ${email.toLowerCase()}`);
    }
  }
  const reset = process.env.RESET_USER_PASSWORD;
  if (reset && reset.includes(":")) {
    const [login, ...rest] = reset.split(":");
    const pw = rest.join(":");
    const [u] = await db.select().from(users).where(sql`lower(${users.username}) = ${login!.toLowerCase()} or lower(${users.email}) = ${login!.toLowerCase()}`);
    if (u && pw.length >= 4) {
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(pw), mustChangePassword: false, mfaRequired: false, totpEnabledAt: null, totpSecretEncrypted: null, failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, u.id));
      await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, u.id));
      await recordAudit(db, systemActor(), { action: "user.password_reset", entityType: "user", entityId: u.id, metadata: { via: "RESET_USER_PASSWORD", policyOverride: true, mfaRequired: false } });
      console.log(`Wachtwoord hersteld voor ${login}`);
    }
  }
} finally {
  await pool.end();
}
