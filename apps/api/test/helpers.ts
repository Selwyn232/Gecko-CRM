import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db/client.js";
import { seed } from "../src/db/seed.js";
import { systemActor } from "../src/lib/context.js";
import { currentStep, totpAt } from "../src/lib/totp.js";
import { roles } from "../src/modules/auth/schema.js";
import { organizations } from "../src/modules/organizations/schema.js";
import { createUser } from "../src/modules/users/service.js";

export const PASSWORD = "een-lang-wachtwoord-123";

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
}

/**
 * Leegt alle tabellen behalve het audit log (dat is onveranderbaar en blijft groeien;
 * tests filteren daarom altijd op hun eigen entiteit) en zet de basisgegevens terug.
 */
export async function resetDb(db: Db) {
  const { rows } = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename <> 'audit_log'`,
  );
  if (rows.length) {
    await db.execute(sql.raw(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`));
  }
  await seed(db);
}

export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL);
  await resetDb(db);
  const app = await buildApp({ config, db });
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export async function geckoOrgId(db: Db) {
  const [org] = await db.select().from(organizations).where(eq(organizations.type, "gecko"));
  return org!.id;
}

export async function roleId(db: Db, key: string) {
  const [r] = await db.select().from(roles).where(eq(roles.key, key));
  return r!.id;
}

let counter = 0;
export async function makeUser(db: Db, roleKeys: string[] = [], email?: string) {
  const roleIds = await Promise.all(roleKeys.map((k) => roleId(db, k)));
  return createUser(db, systemActor(), {
    organizationId: await geckoOrgId(db),
    email: email ?? `user${++counter}-${Date.now()}@gecko.test`,
    name: "Test Gebruiker",
    password: PASSWORD,
    roleIds,
  });
}

/** Volledige login inclusief 2FA-instelling. Geeft headers terug voor vervolgverzoeken. */
export async function loginWithMfa(app: FastifyInstance, email: string, password = PASSWORD) {
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login faalde: ${login.body}`);
  const { token, mfa } = login.json() as { token: string; mfa: "setup" | "verify" };
  const headers = { authorization: `Bearer ${token}` };
  if (mfa !== "setup") throw new Error("helper verwacht een nieuwe gebruiker zonder 2FA");
  const setup = await app.inject({ method: "POST", url: "/auth/mfa/setup", headers });
  const { secret } = setup.json() as { secret: string };
  const enable = await app.inject({
    method: "POST",
    url: "/auth/mfa/enable",
    headers,
    payload: { code: totpAt(secret, currentStep()) },
  });
  if (enable.statusCode !== 200) throw new Error(`2FA faalde: ${enable.body}`);
  return { headers, secret, token, recoveryCodes: (enable.json() as { recoveryCodes: string[] }).recoveryCodes };
}

export async function adminSession(ctx: TestContext) {
  const user = await makeUser(ctx.db, ["beheerder"]);
  return { user, ...(await loginWithMfa(ctx.app, user.email)) };
}
