import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { createDb } from "./client.js";
import { ADMIN_ROLE_KEY, type Permission } from "../modules/auth/permissions.js";
import { rolePermissions, roles } from "../modules/auth/schema.js";
import { productGroups, salesChannelProductGroups, salesChannels, vatCodes, vatRates } from "../modules/catalog/schema.js";
import { organizations } from "../modules/organizations/schema.js";
import { ensureDefaultJourneys } from "../modules/journeys/service.js";
import { ensureMapRegions } from "../modules/planning/map-areas.js";
import { ensureDefaultMessageTemplates } from "../modules/messages/service.js";
import { ensureDefaultChecklists } from "../modules/checklists/service.js";

/**
 * Basisgegevens die elk systeem nodig heeft. Idempotent: veilig om vaker te draaien;
 * bestaande records worden niet overschreven (beheerders kunnen ze daarna aanpassen).
 */

const DEFAULT_ROLES: { key: string; name: string; description: string; isSystem?: boolean; permissions: Permission[] }[] = [
  { key: ADMIN_ROLE_KEY, name: "Beheerder", description: "Volledige toegang", isSystem: true, permissions: [] },
  {
    key: "installatiepartner",
    name: "Installatiepartner",
    description: "Toegang tot het partnerportaal: eigen afspraken, beschikbaarheid en rapporten",
    isSystem: true,
    permissions: ["partner.portal", "mfa.sms"],
  },
  {
    key: "verkooppartner",
    name: "Verkooppartner (adviseur)",
    description: "Verkooppartnerportaal: eigen klanten en offertes maken en versturen, eigen fee zien",
    isSystem: true,
    permissions: ["sales.portal"],
  },
  {
    key: "medewerker",
    name: "Medewerker",
    description: "Kan het hele CRM gebruiken, maar geen instellingen wijzigen",
    permissions: [
      "customers.read",
      "customers.all",
      "customers.manage",
      "projects.read",
      "projects.manage",
      "quotes.read",
      "quotes.manage",
      "invoices.read",
      "planning.read",
      "planning.manage",
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
    description: "Vaste contactpersoon van eigen klanten tot en met de installatie; ziet alleen eigen klanten",
    permissions: ["catalog.read", "organizations.read", "users.read", "customers.read", "customers.manage", "projects.read", "projects.manage", "quotes.read", "quotes.manage", "invoices.read", "planning.read", "planning.manage"],
  },
  {
    key: "manager_klantenservice",
    name: "Manager klantenservice",
    description: "Overzicht over alle klantspecialisten: bezetting, maximum aantal klanten, klanten overzetten",
    permissions: ["catalog.read", "organizations.read", "users.read", "customers.read", "customers.all", "customers.manage", "projects.read", "projects.manage", "quotes.read", "quotes.manage", "invoices.read", "planning.read", "planning.manage", "specialists.manage"],
  },
  {
    key: "planner",
    name: "Planner",
    description: "Planning van schouwen en installaties",
    permissions: ["catalog.read", "organizations.read", "users.read", "customers.read", "customers.all", "projects.read", "projects.manage", "quotes.read", "planning.read", "planning.manage"],
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
      "invoices.read",
      "invoices.manage",
      "customers.read",
      "customers.all",
      "projects.read",
      "quotes.read",
      "planning.read",
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
    const gecko = await ensureOrg("Gecko BV", "gecko");
    // FICTIEVE bedrijfsgegevens (open punt O16). Alleen ingevuld als ze leeg zijn; vervang ze in Organisaties.
    if (!gecko.street) {
      await tx
        .update(organizations)
        .set({
          street: "Voorbeeldstraat",
          houseNumber: "1",
          postalCode: "1234AB",
          city: "Utrecht",
          kvkNumber: "00000000",
          vatNumber: "NL000000000B01",
          iban: "NL00BANK0000000000",
          email: gecko.email ?? "selwyn@gecko.nl",
          phone: gecko.phone ?? "+31300000000",
        })
        .where(eq(organizations.id, gecko.id));
    }
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
    // De 200 kaartgebieden als regio's
    await ensureMapRegions(tx);
    // Standaard klantberichten per status en voor afspraken (nooit overschrijven)
    await ensureDefaultMessageTemplates(tx);
    // Checklists schouw/oplevering per productgroep (startlijst; daarna zelf in te stellen)
    await ensureDefaultChecklists(tx);

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
