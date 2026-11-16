/**
 * Voorbeelddata om het systeem te kunnen bekijken. Alles heeft "(voorbeeld)" in de naam en
 * kan in beheer op inactief worden gezet. Niet draaien op een productieomgeving met echte data.
 */
import { eq } from "drizzle-orm";
import { todayIso } from "../lib/dates.js";
import { systemActor } from "../lib/context.js";
import { addPriceVersion } from "../modules/catalog/prices.js";
import { productGroups, products, salesChannels } from "../modules/catalog/schema.js";
import { createProduct, replaceBom } from "../modules/catalog/service.js";
import { organizations } from "../modules/organizations/schema.js";
import { createOrganization } from "../modules/organizations/service.js";
import { createDb, type Db } from "./client.js";

export async function seedDemo(db: Db) {
  const actor = systemActor();
  const [existing] = await db.select().from(products).where(eq(products.code, "PKG-BAT-10"));
  if (existing) return false;

  const group = async (key: string) => (await db.select().from(productGroups).where(eq(productGroups.key, key)))[0]!;
  const channel = async (key: string) => (await db.select().from(salesChannels).where(eq(salesChannels.key, key)))[0]!;
  const [osw] = await db.select().from(organizations).where(eq(organizations.name, "OSW"));
  const installer = await createOrganization(db, actor, { name: "Installateur Noord BV (voorbeeld)", type: "installation_partner" });

  const bat = await group("thuisbatterij");
  const mk = (code: string, name: string, type: "package" | "component" | "labor", extra: Partial<Parameters<typeof createProduct>[2]> = {}) =>
    createProduct(db, actor, { code, name: `${name} (voorbeeld)`, productGroupId: bat.id, type, vatCode: "hoog", ...extra });

  const pkg = await mk("PKG-BAT-10", "Thuisbatterij 10 kWh — compleet geïnstalleerd", "package", {
    description: "Pakket zoals de klant het koopt: twee batterijmodules, hybride omvormer, montage en installatie.",
  });
  const module = await mk("MOD-BAT-5", "Batterijmodule 5 kWh", "component", { defaultSupplierOrganizationId: osw!.id });
  const inverter = await mk("OMV-HYB-8", "Hybride omvormer 8 kW", "component", { defaultSupplierOrganizationId: osw!.id });
  const mount = await mk("MNT-BAT", "Montagemateriaal thuisbatterij", "component", { defaultSupplierOrganizationId: osw!.id, unit: "set" });
  const labor = await mk("ARB-BAT", "Installatie thuisbatterij", "labor", { unit: "installatie" });

  await replaceBom(db, actor, pkg.id, [
    { componentProductId: module.id, quantity: 2 },
    { componentProductId: inverter.id, quantity: 1 },
    { componentProductId: mount.id, quantity: 1 },
    { componentProductId: labor.id, quantity: 1 },
  ]);

  const today = todayIso();
  for (const [key, cents] of [["greenteam", 849500], ["web", 819500], ["binnendienst", 829500]] as const) {
    await addPriceVersion(db, actor, "sales", { productId: pkg.id, scopeId: (await channel(key)).id, priceCents: cents, validFrom: today });
  }
  await addPriceVersion(db, actor, "purchase", { productId: module.id, scopeId: osw!.id, priceCents: 165000, validFrom: today });
  await addPriceVersion(db, actor, "purchase", { productId: inverter.id, scopeId: osw!.id, priceCents: 142500, validFrom: today });
  await addPriceVersion(db, actor, "purchase", { productId: mount.id, scopeId: osw!.id, priceCents: 18500, validFrom: today });
  await addPriceVersion(db, actor, "partner", { productId: labor.id, scopeId: installer.id, priceCents: 85000, validFrom: today });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ontbreekt");
  const { db, pool } = createDb(url);
  console.log((await seedDemo(db)) ? "Voorbeelddata aangemaakt" : "Voorbeelddata bestond al");
  await pool.end();
}
