import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { randomToken } from "../../lib/crypto.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { roles, users } from "../auth/schema.js";
import { addPriceVersion, effectivePrice } from "../catalog/prices.js";
import { productGroups, products, salesChannelProductGroups, salesChannels } from "../catalog/schema.js";
import { statusByKeyInJourneyOf } from "../journeys/service.js";
import { advisors, organizations } from "../organizations/schema.js";
import { addDays, postalNumber, setAvailability, setPartnerRegions } from "../planning/service.js";
import { regions } from "../planning/schema.js";
import { projects } from "../projects/schema.js";
import { changeStatus } from "../projects/service.js";
import { acceptQuote, addLine, createQuote, sendQuote } from "../quotes/service.js";
import { createCustomer } from "../customers/service.js";
import { getSetting } from "../settings/service.js";
import { createUser } from "../users/service.js";

export const TEST_PARTNER_NAME = "Testinstallateur (test)";
export const TEST_SALES_PARTNER_NAME = "Greenteam (test)";
export const TEST_CHANNEL_KEY = "greenteam_test";
export const TEST_PARTNER_USERNAME = "testinstallateur";
/** Inlognaam van de testinstallateur (fictief domein; inloggen gaat via "Inloggen als"). */
export const TEST_PARTNER_EMAIL = "testinstallateur@gecko.test";

/** Testinstallateur met gebruiker; wordt hergebruikt bij volgende scenario's. */
async function ensureTestPartner(db: Db, actor: ActorContext) {
  let [org] = await db.select().from(organizations).where(eq(organizations.name, TEST_PARTNER_NAME));
  if (!org) [org] = await db.insert(organizations).values({ name: TEST_PARTNER_NAME, type: "installation_partner" }).returning();
  let [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${TEST_PARTNER_EMAIL} or lower(${users.username}) = ${TEST_PARTNER_USERNAME}`);
  if (!user) {
    const [role] = await db.select().from(roles).where(eq(roles.key, "installatiepartner"));
    // Willekeurig wachtwoord: inloggen gebeurt via "Inloggen als".
    const created = await createUser(db, actor, {
      organizationId: org!.id,
      email: TEST_PARTNER_EMAIL,
      name: "Monteur Test",
      password: `${randomToken(18)}Aa1`,
      roleIds: [role!.id],
      mfaRequired: false,
      mustChangePassword: false,
    });
    [user] = await db.select().from(users).where(eq(users.id, created.id));
  }
  if (!user!.isTechnician) [user] = await db.update(users).set({ isTechnician: true }).where(eq(users.id, user!.id)).returning();
  return { org: org!, user: user! };
}

/**
 * Testkopie van Greenteam: eigen verkooppartner (e-mail = testadres, zodat de akkoordmail bij de tester komt),
 * testadviseur en kanaal met fee (die van Greenteam, anders 10%). Raakt de echte Greenteam niet.
 */
async function ensureTestSalesChannel(db: Db, email: string) {
  let [org] = await db.select().from(organizations).where(eq(organizations.name, TEST_SALES_PARTNER_NAME));
  if (!org) [org] = await db.insert(organizations).values({ name: TEST_SALES_PARTNER_NAME, type: "sales_partner", email }).returning();
  else await db.update(organizations).set({ email }).where(eq(organizations.id, org.id));
  let [advisor] = await db.select().from(advisors).where(eq(advisors.organizationId, org!.id));
  if (!advisor) [advisor] = await db.insert(advisors).values({ organizationId: org!.id, name: "Testadviseur (test)" }).returning();
  let [channel] = await db.select().from(salesChannels).where(eq(salesChannels.key, TEST_CHANNEL_KEY));
  if (!channel) {
    const [real] = await db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
    [channel] = await db
      .insert(salesChannels)
      .values({ key: TEST_CHANNEL_KEY, name: "Greenteam (test)", salesPartnerOrganizationId: org!.id, feeBasisPoints: real?.feeBasisPoints ?? 1000 })
      .returning();
  }
  const groups = await db.select({ id: productGroups.id }).from(productGroups);
  for (const g of groups) await db.insert(salesChannelProductGroups).values({ salesChannelId: channel!.id, productGroupId: g.id }).onConflictDoNothing();
  return { channel: channel!, advisorId: advisor!.id };
}

/**
 * Maakt een volledig testscenario: testklant met offerte (geaccepteerd), project klaar voor de schouw,
 * en een testinstallateur met werkgebied en beschikbaarheid voor de komende 14 dagen.
 * Alleen in testmodus.
 */
export async function createTestScenario(db: Db, actor: ActorContext, input: { productGroupId: string; email: string; postalCode: string; salesChannelId?: string | null }) {
  if (!(await getSetting(db, "test.mode"))) throw forbidden("test_mode_off", "Zet eerst de testmodus aan bij Instellingen");
  const [group] = await db.select().from(productGroups).where(eq(productGroups.id, input.productGroupId));
  if (!group) throw badRequest("unknown_product_group", "Productgroep bestaat niet");

  // Een kanaal dat deze productgroep verkoopt, met een pakket dat vandaag een prijs heeft.
  const channels = await db
    .select({ channel: salesChannels })
    .from(salesChannelProductGroups)
    .innerJoin(salesChannels, eq(salesChannels.id, salesChannelProductGroups.salesChannelId))
    .where(and(eq(salesChannelProductGroups.productGroupId, group.id), eq(salesChannels.isActive, true)));
  const packages = await db
    .select()
    .from(products)
    .where(and(eq(products.productGroupId, group.id), eq(products.type, "package"), eq(products.isActive, true)))
    .orderBy(asc(products.code));
  let pick: { channelId: string; productId: string; priceCents: number } | null = null;
  for (const c of channels) {
    if (input.salesChannelId && c.channel.id !== input.salesChannelId) continue;
    for (const p of packages) {
      const price = await effectivePrice(db, "sales", p.id, c.channel.id, todayIso());
      if (price) {
        pick = { channelId: c.channel.id, productId: p.id, priceCents: price.priceCents };
        break;
      }
    }
    if (pick) break;
  }
  if (!pick) {
    throw badRequest(
      "no_priced_package",
      input.salesChannelId
        ? `Er is geen pakket in ${group.name} met een verkoopprijs voor dit verkoopkanaal. Vul die eerst in bij Producten.`
        : `Er is geen pakket in ${group.name} met een verkoopprijs. Maak dat eerst aan bij Producten.`,
    );
  }

  // Standaard: via "Greenteam (test)", met de verkoopprijs van het gevonden pakket.
  let advisorId: string | null = null;
  if (!input.salesChannelId) {
    const t = await ensureTestSalesChannel(db, input.email);
    if (!(await effectivePrice(db, "sales", pick.productId, t.channel.id, todayIso()))) {
      await addPriceVersion(db, actor, "sales", { productId: pick.productId, scopeId: t.channel.id, priceCents: pick.priceCents, validFrom: todayIso() });
    }
    pick = { ...pick, channelId: t.channel.id };
    advisorId = t.advisorId;
  }

  const { org: partner, user: partnerUser } = await ensureTestPartner(db, actor);
  // Akkoordmail voor de selfbilling van de installateur naar de tester; partnertarief zodat er iets uit te betalen is.
  await db.update(organizations).set({ email: input.email }).where(eq(organizations.id, partner.id));
  if (!(await effectivePrice(db, "partner", pick.productId, partner.id, todayIso()))) {
    await addPriceVersion(db, actor, "partner", { productId: pick.productId, scopeId: partner.id, priceCents: Math.round(pick.priceCents * 0.3), validFrom: todayIso() });
  }

  // Werkgebied: het kaartgebied (of eerste regio) waar de testpostcode in valt.
  const allRegions = await db.select().from(regions).where(eq(regions.isActive, true));
  const pc = postalNumber(input.postalCode);
  const region = allRegions.find((r) => r.postalRanges.some(([a, b]) => pc >= a && pc <= b));
  if (!region) throw badRequest("postal_outside_regions", "Deze postcode valt in geen enkele regio");
  await setPartnerRegions(db, actor, partner.id, [region.id]);
  const today = todayIso();
  await setAvailability(
    db,
    actor,
    partner.id,
    partnerUser.id,
    Array.from({ length: 14 }, (_, d) => addDays(today, d)).flatMap((date) => (["08", "10", "12", "14"] as const).map((part) => ({ date, part, available: true }))),
  );

  const stamp = new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", dateStyle: "short", timeStyle: "short" });
  const customer = await createCustomer(db, actor, {
    firstName: "Test",
    lastName: `Klant ${stamp} (test)`,
    email: input.email,
    salesChannelId: pick.channelId,
    notes: "Aangemaakt als testscenario.",
    property: { street: "Teststraat", houseNumber: "1", postalCode: input.postalCode, city: "Testplaats" },
  });
  const quote = await createQuote(db, actor, {
    customerId: customer.id,
    propertyId: customer.properties[0]!.id,
    productGroupId: group.id,
    salesChannelId: pick.channelId,
    advisorId,
    installationPartnerId: partner.id,
    customerNote: "Testofferte",
  });
  await addLine(db, actor, quote.id, { productId: pick.productId, quantity: 1 });
  await sendQuote(db, actor, quote.id);
  const accepted = await acceptQuote(db, actor, quote.id, { acceptedByName: "Test Klant", method: "email" });
  const projectId = accepted.projectId!;

  // Naar "Schouw in te plannen" (of de eerste status die naar het inplannen van de schouw leidt).
  const [proj] = await db.select({ statusId: projects.statusId }).from(projects).where(eq(projects.id, projectId));
  const target = proj ? await statusByKeyInJourneyOf(db, proj.statusId, "schouw_inplannen") : undefined;
  if (target) {
    try {
      await changeStatus(db, actor, projectId, { toStatusId: target.id, note: "Testscenario" });
    } catch {
      /* klantreis is aangepast; project blijft in de startstatus */
    }
  }
  await recordAudit(db, actor, { action: "test.scenario_created", entityType: "project", entityId: projectId });
  const [channel] = await db.select().from(salesChannels).where(eq(salesChannels.id, pick.channelId));
  return {
    projectId,
    customerId: customer.id,
    quoteId: quote.id,
    partnerId: partner.id,
    partnerUserId: partnerUser.id,
    regionName: region.name,
    salesChannelName: channel!.name,
    feeBasisPoints: channel!.feeBasisPoints,
  };
}
