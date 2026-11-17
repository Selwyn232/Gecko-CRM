import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { salesPrices } from "../src/modules/catalog/schema.js";
import { organizations } from "../src/modules/organizations/schema.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, type TestContext, partnerPayload } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let channelId: string;
let oswId: string;
let partnerId: string;

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam")))[0]!.id;
  oswId = (await ctx.db.select().from(organizations).where(eq(organizations.name, "OSW")))[0]!.id;
  const partner = await ctx.app.inject({
    method: "POST",
    url: "/api/organizations",
    headers: h,
    payload: await partnerPayload(ctx.db, "Installateur Noord"),
  });
  partnerId = partner.json().id;
});
afterAll(async () => ctx.close());

const post = (url: string, payload: unknown) => ctx.app.inject({ method: "POST", url, headers: h, payload: payload as object });

async function product(code: string, type: string, extra: Record<string, unknown> = {}) {
  const res = await post("/api/products", { code, name: code, productGroupId: groupId, type, vatCode: "hoog", ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; code: string };
}

describe("productcatalogus", () => {
  it("seed bevat productgroepen, kanalen en btw", async () => {
    const groups = (await ctx.app.inject({ method: "GET", url: "/api/product-groups", headers: h })).json();
    expect(groups.map((g: { key: string }) => g.key)).toEqual(["thuisbatterij", "warmtepomp", "zonnepanelen", "isolatie"]);
    const vat = (await ctx.app.inject({ method: "GET", url: "/api/vat-codes", headers: h })).json();
    expect(vat.find((v: { code: string }) => v.code === "hoog").currentRateBasisPoints).toBe(2100);
  });

  it("productcode is uniek en wordt genormaliseerd", async () => {
    const p = await product("bat-10kwh", "package");
    expect(p.code).toBe("BAT-10KWH");
    const dup = await post("/api/products", { code: "BAT-10KWH", name: "x", productGroupId: groupId, type: "package", vatCode: "hoog" });
    expect(dup.statusCode).toBe(409);
  });

  it("prijsversies: geldende prijs volgt de ingangsdatum", async () => {
    const p = await product("BAT-PRIJS", "package");
    const today = todayIso();
    const r1 = await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 500000, validFrom: today });
    expect(r1.statusCode, r1.body).toBe(201);
    await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 550000, validFrom: addDays(today, 30) });

    const now = await ctx.app.inject({ method: "GET", url: `/api/products/${p.id}/sales-prices/effective?scopeId=${channelId}`, headers: h });
    expect(now.json().price.priceCents).toBe(500000);
    const later = await ctx.app.inject({
      method: "GET",
      url: `/api/products/${p.id}/sales-prices/effective?scopeId=${channelId}&date=${addDays(today, 31)}`,
      headers: h,
    });
    expect(later.json().price.priceCents).toBe(550000);
    const before = await ctx.app.inject({
      method: "GET",
      url: `/api/products/${p.id}/sales-prices/effective?scopeId=${channelId}&date=${addDays(today, -1)}`,
      headers: h,
    });
    expect(before.json().price).toBeNull();
  });

  it("ingangsdatum in het verleden en verwijderen van ingegane prijs zijn geweigerd", async () => {
    const p = await product("BAT-HIST", "package");
    const past = await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 1, validFrom: addDays(todayIso(), -1) });
    expect(past.json().error.code).toBe("valid_from_in_past");

    const current = (await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 100, validFrom: todayIso() })).json();
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/sales-prices/${current.id}`, headers: h });
    expect(del.json().error.code).toBe("price_already_effective");

    const future = (await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 200, validFrom: addDays(todayIso(), 5) })).json();
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/sales-prices/${future.id}`, headers: h })).statusCode).toBe(204);
  });

  it("kanaal verkoopt alleen de eigen productgroepen", async () => {
    const p = await product("BAT-KANAAL", "package");
    const ch = await post("/api/sales-channels", { key: "alleen_warmtepomp", name: "Alleen WP", productGroupIds: [] });
    const res = await post(`/api/products/${p.id}/sales-prices`, { scopeId: ch.json().id, priceCents: 1, validFrom: todayIso() });
    expect(res.json().error.code).toBe("product_group_not_in_channel");
  });

  it("inkoopprijs alleen bij een leverancier, partnertarief alleen bij een installatiepartner", async () => {
    const p = await product("BAT-SCOPE", "component");
    const wrong = await post(`/api/products/${p.id}/purchase-prices`, { scopeId: partnerId, priceCents: 1, validFrom: todayIso() });
    expect(wrong.json().error.code).toBe("invalid_scope_organization");
    const ok = await post(`/api/products/${p.id}/purchase-prices`, { scopeId: oswId, priceCents: 1, validFrom: todayIso() });
    expect(ok.statusCode).toBe(201);
  });

  it("inkoopprijzen zijn afgeschermd voor wie het recht mist", async () => {
    const p = await product("BAT-GEHEIM", "component");
    const u = await makeUser(ctx.db, ["klantspecialist"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    expect((await ctx.app.inject({ method: "GET", url: `/api/products/${p.id}`, headers })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/api/products/${p.id}/purchase-prices`, headers })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/api/products/${p.id}/cost`, headers })).statusCode).toBe(403);
  });

  it("productcode op slot zodra product in gebruik is", async () => {
    const p = await product("BAT-SLOT", "package");
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/products/${p.id}`, headers: h, payload: { code: "BAT-SLOT2" } })).statusCode).toBe(200);
    await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 1, validFrom: todayIso() });
    const res = await ctx.app.inject({ method: "PATCH", url: `/api/products/${p.id}`, headers: h, payload: { code: "BAT-SLOT3" } });
    expect(res.json().error.code).toBe("product_code_locked");
  });

  it("stuklijst weigert cirkels", async () => {
    const a = await product("KIT-A", "component");
    const b = await product("KIT-B", "component");
    const put = (id: string, items: unknown) => ctx.app.inject({ method: "PUT", url: `/api/products/${id}/bom`, headers: h, payload: { items } });
    expect((await put(a.id, [{ componentProductId: b.id, quantity: 1 }])).statusCode).toBe(200);
    const cycle = await put(b.id, [{ componentProductId: a.id, quantity: 1 }]);
    expect(cycle.json().error.code).toBe("bom_cycle");
    expect((await put(a.id, [{ componentProductId: a.id, quantity: 1 }])).json().error.code).toBe("bom_cycle");
  });

  it("kostprijs uit stuklijst: inkoop + partnertarief, ontbrekende prijzen gemeld", async () => {
    const pkg = await product("PKG-KOST", "package");
    const module = await product("MOD-5KWH", "component", { defaultSupplierOrganizationId: oswId });
    const inverter = await product("OMV-HYB", "component", { defaultSupplierOrganizationId: oswId });
    const labor = await product("ARB-BAT", "labor");

    await ctx.app.inject({
      method: "PUT",
      url: `/api/products/${pkg.id}/bom`,
      headers: h,
      payload: {
        items: [
          { componentProductId: module.id, quantity: 2 },
          { componentProductId: inverter.id, quantity: 1 },
          { componentProductId: labor.id, quantity: 1 },
        ],
      },
    });
    await post(`/api/products/${module.id}/purchase-prices`, { scopeId: oswId, priceCents: 150000, validFrom: todayIso() });
    await post(`/api/products/${labor.id}/partner-rates`, { scopeId: partnerId, priceCents: 60000, validFrom: todayIso() });

    const res = await ctx.app.inject({ method: "GET", url: `/api/products/${pkg.id}/cost?partnerOrganizationId=${partnerId}`, headers: h });
    const cost = res.json();
    expect(cost.totalCents).toBe(2 * 150000 + 60000);
    expect(cost.complete).toBe(false);
    expect(cost.missingPrices).toEqual(["OMV-HYB"]);
  });

  it("prijswijzigingen staan in het audit log", async () => {
    const p = await product("BAT-AUDIT", "package");
    await post(`/api/products/${p.id}/sales-prices`, { scopeId: channelId, priceCents: 777, validFrom: todayIso() });
    const log = (await ctx.app.inject({ method: "GET", url: `/api/audit-log?entityType=product&entityId=${p.id}`, headers: h })).json();
    expect(log.items.map((i: { action: string }) => i.action)).toEqual(["price.sales.created", "product.created"]);
    const rows = await ctx.db.select().from(salesPrices).where(eq(salesPrices.productId, p.id));
    expect(rows[0]!.createdBy).not.toBeNull();
  });
});
