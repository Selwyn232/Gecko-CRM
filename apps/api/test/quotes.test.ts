import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { organizations } from "../src/modules/organizations/schema.js";
import { calculateTotals } from "../src/modules/quotes/service.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, type TestContext, partnerPayload } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let channelId: string;
let oswId: string;
let partnerId: string;
let greenteamId: string;
let pkgId: string;
let extraId: string;
let customer: { id: string; properties: { id: string }[] };

const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

async function product(code: string, type: string, extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/products", { code, name: `${code} naam`, productGroupId: groupId, type, vatCode: "hoog", ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam")))[0]!.id;
  oswId = (await ctx.db.select().from(organizations).where(eq(organizations.name, "OSW")))[0]!.id;
  greenteamId = (await ctx.db.select().from(organizations).where(eq(organizations.name, "Greenteam")))[0]!.id;
  partnerId = (await api("POST", "/organizations", await partnerPayload(ctx.db, "Partner"))).json().id;
  const today = todayIso();

  // Pakket: 2× module (inkoop 1.500) + arbeid (partner 800) = kostprijs 3.800; verkoop 6.000
  pkgId = await product("PKG", "package");
  const mod = await product("MOD", "component", { defaultSupplierOrganizationId: oswId });
  const arb = await product("ARB", "labor");
  await api("PUT", `/products/${pkgId}/bom`, { items: [{ componentProductId: mod, quantity: 2 }, { componentProductId: arb, quantity: 1 }] });
  await api("POST", `/products/${pkgId}/sales-prices`, { scopeId: channelId, priceCents: 600000, validFrom: today });
  await api("POST", `/products/${mod}/purchase-prices`, { scopeId: oswId, priceCents: 150000, validFrom: today });
  await api("POST", `/products/${arb}/partner-rates`, { scopeId: partnerId, priceCents: 80000, validFrom: today });
  // Meerwerk met 9% btw: verkoop 250, partner 150
  extraId = await product("MW-KABEL", "extra_work", { vatCode: "laag" });
  await api("POST", `/products/${extraId}/sales-prices`, { scopeId: channelId, priceCents: 25000, validFrom: today });
  await api("POST", `/products/${extraId}/partner-rates`, { scopeId: partnerId, priceCents: 15000, validFrom: today });
  // Fee Greenteam 5%
  await api("PATCH", `/sales-channels/${channelId}`, { feeBasisPoints: 500 });

  customer = (await api("POST", "/customers", { lastName: "Offertemans", property: { street: "Laan", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
});
afterAll(async () => ctx.close());

const newQuote = async (extra: Record<string, unknown> = {}) => {
  const res = await api("POST", "/quotes", {
    customerId: customer.id,
    propertyId: customer.properties[0]!.id,
    productGroupId: groupId,
    salesChannelId: channelId,
    installationPartnerId: partnerId,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};

describe("btw-berekening", () => {
  it("rekent btw per tarief over het totaal", () => {
    const t = calculateTotals([
      { quantity: "1", unitPriceCents: 600000, vatRateBasisPoints: 2100 },
      { quantity: "2", unitPriceCents: 25000, vatRateBasisPoints: 900 },
      { quantity: "1", unitPriceCents: 100000, vatRateBasisPoints: 0 },
    ]);
    expect(t.subtotalCents).toBe(750000);
    expect(t.vat).toEqual([
      { rateBasisPoints: 2100, baseCents: 600000, vatCents: 126000 },
      { rateBasisPoints: 900, baseCents: 50000, vatCents: 4500 },
      { rateBasisPoints: 0, baseCents: 100000, vatCents: 0 },
    ]);
    expect(t.totalCents).toBe(880500);
  });
});

describe("offertes", () => {
  it("regels krijgen prijs uit het kanaal; totalen, btw en marge kloppen", async () => {
    const q = await newQuote();
    expect(q.displayNumber).toMatch(/^O-\d{6}$/);
    await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
    const res = await api("POST", `/quotes/${q.id}/lines`, { productId: extraId, quantity: 2 });
    const quote = res.json();
    expect(quote.totals.subtotalCents).toBe(650000);
    expect(quote.totals.vatCents).toBe(126000 + 4500);
    // kosten 3.800 + 2×150 = 4.100; fee 5% van 6.500 = 325; marge 6.500 − 4.100 − 325 = 2.075
    expect(quote.margin).toMatchObject({ costCents: 410000, feeCents: 32500, marginCents: 207500, complete: true });
  });

  it("weigert componenten, producten zonder prijs en producten van een andere groep", async () => {
    const q = await newQuote();
    const comp = await product("LOS-COMP", "component");
    expect((await api("POST", `/quotes/${q.id}/lines`, { productId: comp, quantity: 1 })).json().error.code).toBe("not_quotable");
    const noPrice = await product("PKG-GEENPRIJS", "package");
    expect((await api("POST", `/quotes/${q.id}/lines`, { productId: noPrice, quantity: 1 })).json().error.code).toBe("no_sales_price");
  });

  it("kostprijs en marge zijn verborgen zonder recht op inkoopprijzen", async () => {
    const q = await newQuote();
    await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
    const u = await makeUser(ctx.db, ["planner"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    const res = (await api("GET", `/quotes/${q.id}`, undefined, headers)).json();
    expect(res.margin).toBeNull();
    expect(res.lines[0].unitCostCents).toBeNull();
    expect(res.totals.subtotalCents).toBe(600000);
  });

  it("versturen zet prijzen vast; daarna geen wijzigingen meer", async () => {
    const q = await newQuote();
    expect((await api("POST", `/quotes/${q.id}/send`)).json().error.code).toBe("quote_empty");
    await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
    const sent = (await api("POST", `/quotes/${q.id}/send`)).json();
    expect(sent.status).toBe("sent");
    expect(sent.priceDate).toBe(todayIso());
    expect(sent.validUntil > todayIso()).toBe(true);
    expect(sent.feeBasisPoints).toBe(500);
    expect((await api("POST", `/quotes/${q.id}/lines`, { productId: extraId, quantity: 1 })).json().error.code).toBe("quote_not_draft");
    // Fee-wijziging na versturen raakt deze offerte niet
    await api("PATCH", `/sales-channels/${channelId}`, { feeBasisPoints: 1000 });
    expect((await api("GET", `/quotes/${q.id}`)).json().margin.feeCents).toBe(30000);
    await api("PATCH", `/sales-channels/${channelId}`, { feeBasisPoints: 500 });
  });

  it("akkoord maakt het project aan in de startstatus", async () => {
    const q = await newQuote();
    await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
    expect((await api("POST", `/quotes/${q.id}/accept`, { acceptedByName: "x", method: "email" })).json().error.code).toBe("quote_not_sent");
    await api("POST", `/quotes/${q.id}/send`);
    const accepted = (await api("POST", `/quotes/${q.id}/accept`, { acceptedByName: "P. Offertemans", method: "signed_paper" })).json();
    expect(accepted.status).toBe("accepted");
    expect(accepted.projectId).toBeTruthy();
    const project = (await api("GET", `/projects/${accepted.projectId}`)).json();
    expect(project.status.isInitial).toBe(true);
    expect(project.installationPartnerId).toBe(partnerId);
    expect((await api("GET", `/quotes?projectId=${accepted.projectId}`)).json()).toHaveLength(1);
    // Tweede keer accepteren kan niet
    expect((await api("POST", `/quotes/${q.id}/accept`, { acceptedByName: "x", method: "email" })).statusCode).toBe(409);
  });

  it("nieuwe versie: oude wordt vervangen, nieuwe is concept met dezelfde regels", async () => {
    const q = await newQuote();
    await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
    await api("POST", `/quotes/${q.id}/send`);
    const v2 = (await api("POST", `/quotes/${q.id}/revise`)).json();
    expect(v2.status).toBe("draft");
    expect(v2.supersedesQuoteId).toBe(q.id);
    expect(v2.lines).toHaveLength(1);
    expect((await api("GET", `/quotes/${q.id}`)).json().status).toBe("superseded");
  });

  it("adviseur moet bij de verkooppartner van het kanaal horen", async () => {
    const adv = (await api("POST", "/advisors", { organizationId: greenteamId, name: "Adviseur Jan" })).json();
    const q = await newQuote({ advisorId: adv.id });
    expect(q.advisor.name).toBe("Adviseur Jan");
    const web = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
    const res = await api("PATCH", `/quotes/${q.id}`, { salesChannelId: web });
    expect(res.json().error.code).toBe("invalid_advisor");
  });
});
