import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import { ADMIN_ROLE_KEY, type Permission } from "../modules/auth/permissions.js";
import { rolePermissions, roles } from "../modules/auth/schema.js";
import { productGroups, salesChannelProductGroups, salesChannels, vatCodes, vatRates } from "../modules/catalog/schema.js";
import { organizations } from "../modules/organizations/schema.js";
import { ensureDefaultJourneys } from "../modules/journeys/service.js";

/**
 * Basisgegevens die elk systeem nodig heeft. Idempotent: veilig om vaker te draaien;
 * bestaande records worden niet overschreven (beheerders kunnen ze daarna aanpassen).
 */

const DEFAULT_ROLES: { key: string; name: string; description: string; isSystem?: boolean; permissions: Permission[] }[] = [
  { key: ADMIN_ROLE_KEY, name: "Beheerder", description: "Volledige toegang", isSystem: true, permissions: [] },
  {
    key: "medewerker",
    name: "Medewerker",
    description: "Kan het hele CRM gebruiken, maar geen instellingen wijzigen",
    permissions: [
      "customers.read",
      "customers.manage",
      "projects.read",
      "projects.manage",
      "catalog.read",
      "purchase_prices.read",
      "organizations.read",
      "users.read",
      "audit.read",
    ],
  },
  {
    key: "klantspecialist",
    name: "Klantspecialist",
    description: "Klantcontact en dossierbeheer",
    permissions: ["catalog.read", "organizations.read", "users.read", "customers.read", "customers.manage", "projects.read", "projects.manage"],
  },
  {
    key: "planner",
    name: "Planner",
    description: "Planning van schouwen en installaties",
    permissions: ["catalog.read", "organizations.read", "users.read", "customers.read", "projects.read", "projects.manage"],
  },
  {
    key: "finance",
    name: "Finance",
    description: "Facturatie, betalingen, prijzen en marges",
    permissions: [
      "catalog.read",
      "organizations.read",
      "users.read",
      "audit.read",
      "sales_prices.manage",
      "purchase_prices.read",
      "purchase_prices.manage",
      "customers.read",
      "projects.read",
    ],
  },
];

/** Btw-tarieven per 2026. Wijzigingen later via het systeem met een ingangsdatum. */
const VAT = [
  { code: "hoog", name: "Hoog tarief", rate: 2100 },
  { code: "laag", name: "Laag tarief", rate: 900 },
  { code: "nul", name: "Nultarief", rate: 0 },
];

const PRODUCT_GROUPS = [
  { key: "thuisbatterij", name: "Thuisbatterij", sortOrder: 10 },
  { key: "warmtepomp", name: "Warmtepomp", sortOrder: 20 },
  { key: "zonnepanelen", name: "Zonnepanelen", sortOrder: 30 },
  { key: "isolatie", name: "Isolatie", sortOrder: 40 },
];

export async function seed(db: Db) {
  await db.transaction(async (tx) => {
    // Organisaties
    const ensureOrg = async (name: string, type: (typeof organizations.$inferInsert)["type"]) => {
      const [existing] = await tx.select().from(organizations).where(eq(organizations.name, name));
      if (existing) return existing;
      const [created] = await tx.insert(organizations).values({ name, type }).returning();
      return created!;
    };
    await ensureOrg("Gecko BV", "gecko");
    const greenteam = await ensureOrg("Greenteam", "sales_partner");
    await ensureOrg("OSW", "supplier");

    // Rollen
    for (const r of DEFAULT_ROLES) {
      const [existing] = await tx.select().from(roles).where(eq(roles.key, r.key));
      if (existing) continue;
      const [role] = await tx
        .insert(roles)
        .values({ key: r.key, name: r.name, description: r.description, isSystem: r.isSystem ?? false })
        .returning();
      if (r.permissions.length) {
        await tx.insert(rolePermissions).values(r.permissions.map((permission) => ({ roleId: role!.id, permission })));
      }
    }

    // Btw
    for (const v of VAT) {
      const inserted = await tx.insert(vatCodes).values({ code: v.code, name: v.name }).onConflictDoNothing().returning();
      if (inserted.length) await tx.insert(vatRates).values({ vatCode: v.code, rateBasisPoints: v.rate, validFrom: "2000-01-01" });
    }

    // Productgroepen
    for (const g of PRODUCT_GROUPS) await tx.insert(productGroups).values(g).onConflictDoNothing();
    const groups = await tx.select().from(productGroups);

    // Verkoopkanalen (startinrichting: alle productgroepen; aan te passen in beheer)
    const channels = [
      { key: "greenteam", name: "Greenteam", salesPartnerOrganizationId: greenteam.id },
      { key: "web", name: "Web", salesPartnerOrganizationId: null },
      { key: "binnendienst", name: "Binnendienst", salesPartnerOrganizationId: null },
    ];
    // Klantreis per productgroep (alleen als die er nog niet is)
    await ensureDefaultJourneys(tx);

    for (const c of channels) {
      const inserted = await tx.insert(salesChannels).values(c).onConflictDoNothing().returning();
      if (inserted.length) {
        await tx
          .insert(salesChannelProductGroups)
          .values(groups.map((g) => ({ salesChannelId: inserted[0]!.id, productGroupId: g.id })));
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ontbreekt");
  const { db, pool } = createDb(url);
  await seed(db);
  await pool.end();
  console.log("Basisgegevens aangemaakt");
}
