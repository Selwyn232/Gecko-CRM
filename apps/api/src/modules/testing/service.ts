import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { randomToken } from "../../lib/crypto.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { roles, users } from "../auth/schema.js";
import { effectivePrice } from "../catalog/prices.js";
import { productGroups, products, salesChannelProductGroups, salesChannels } from "../catalog/schema.js";
import { journeyStatuses } from "../journeys/schema.js";
import { organizations } from "../organizations/schema.js";
import { addDays, postalNumber, setAvailability, setPartnerRegions } from "../planning/service.js";
import { regions } from "../planning/schema.js";
import { changeStatus } from "../projects/service.js";
import { acceptQuote, addLine, createQuote, sendQuote } from "../quotes/service.js";
import { createCustomer } from "../customers/service.js";
import { getSetting } from "../settings/service.js";
import { createUser } from "../users/service.js";

export const TEST_PARTNER_NAME = "Testinstallateur (test)";
export const TEST_PARTNER_USERNAME = "testinstallateur";

/** Testinstallateur met gebruiker; wordt hergebruikt bij volgende scenario's. */
async function ensureTestPartner(db: Db, actor: ActorContext) {
  let [org] = await db.select().from(organizations).where(eq(organizations.name, TEST_PARTNER_NAME));
  if (!org) [org] = await db.insert(organizations).values({ name: TEST_PARTNER_NAME, type: "installation_partner" }).returning();
  let [user] = await db.select().from(users).where(eq(sql`lower(${users.username})`, TEST_PARTNER_USERNAME));
  if (!user) {
    const [role] = await db.select().from(roles).where(eq(roles.key, "installatiepartner"));
    // Willekeurig wachtwoord: inloggen gebeurt via "Inloggen als".
    const created = await createUser(db, actor, {
      organizationId: org!.id,
      username: TEST_PARTNER_USERNAME,
      name: "Monteur Test",
      password: `${randomToken(18)}Aa1`,
      roleIds: [role!.id],
      mfaRequired: false,
      mustChangePassword: false,
    });
    [user] = await db.select().from(users).where(eq(users.id, created.id));
  }
  return { org: org!, user: user! };
}

/**
 * Maakt een volledig testscenario: testklant met offerte (geaccepteerd), project klaar voor de schouw,
 * en een testinstallateur met werkgebied en beschikbaarheid voor de komende 14 dagen.
 * Alleen in testmodus.
 */
export async function createTestScenario(db: Db, actor: ActorContext, input: { productGroupId: string; email: string; postalCode: string }) {
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
  let pick: { channelId: string; productId: string } | null = null;
  for (const c of channels) {
    for (const p of packages) {
      if (await effectivePrice(db, "sales", p.id, c.channel.id, todayIso())) {
        pick = { channelId: c.channel.id, productId: p.id };
        break;
      }
    }
    if (pick) break;
  }
  if (!pick) throw badRequest("no_priced_package", `Er is geen pakket in ${group.name} met een verkoopprijs. Maak dat eerst aan bij Producten.`);

  const { org: partner, user: partnerUser } = await ensureTestPartner(db, actor);

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
    Array.from({ length: 14 }, (_, d) => addDays(today, d)).flatMap((date) => (["morning", "afternoon"] as const).map((part) => ({ date, part, available: true }))),
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
    installationPartnerId: partner.id,
    customerNote: "Testofferte",
  });
  await addLine(db, actor, quote.id, { productId: pick.productId, quantity: 1 });
  await sendQuote(db, actor, quote.id);
  const accepted = await acceptQuote(db, actor, quote.id, { acceptedByName: "Test Klant", method: "email" });
  const projectId = accepted.projectId!;

  // Naar "Schouw in te plannen" (of de eerste status die naar het inplannen van de schouw leidt).
  const [target] = await db
    .select()
    .from(journeyStatuses)
    .where(and(eq(journeyStatuses.productGroupId, group.id), eq(journeyStatuses.key, "schouw_inplannen")));
  if (target) {
    try {
      await changeStatus(db, actor, projectId, { toStatusId: target.id, note: "Testscenario" });
    } catch {
      /* klantreis is aangepast; project blijft in de startstatus */
    }
  }
  await recordAudit(db, actor, { action: "test.scenario_created", entityType: "project", entityId: projectId });
  return { projectId, customerId: customer.id, quoteId: quote.id, partnerId: partner.id, partnerUserId: partnerUser.id, regionName: region.name };
}
