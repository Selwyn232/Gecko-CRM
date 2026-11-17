import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
});
afterAll(async () => ctx.close());

describe("fee per productgroep", () => {
  it("productgroep-fee gaat voor de kanaalfee; vastgelegd bij versturen; blijft staan bij wijzigen", async () => {
    const [ch] = await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
    const bat = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
    const zp = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "zonnepanelen")))[0]!.id;
    const upd = await call("PATCH", `/sales-channels/${ch!.id}`, { feeBasisPoints: 500, groupFees: { [bat]: 1000 } });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().groupFees[bat]).toBe(1000);
    // Andere wijziging (naam): fee per productgroep blijft
    expect((await call("PATCH", `/sales-channels/${ch!.id}`, { name: "Greenteam" })).json().groupFees[bat]).toBe(1000);

    const quote = async (groupId: string, code: string) => {
      const pkg = (await call("POST", "/products", { code, name: code, productGroupId: groupId, type: "package", vatCode: "hoog" })).json().id;
      await call("POST", `/products/${pkg}/sales-prices`, { scopeId: ch!.id, priceCents: 1_000_000, validFrom: todayIso() });
      const c = (await call("POST", "/customers", { lastName: code, property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
      const q = (await call("POST", "/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId: ch!.id })).json();
      await call("POST", `/quotes/${q.id}/lines`, { productId: pkg, quantity: 1 });
      expect((await call("GET", `/quotes/${q.id}`)).json().margin.feeCents).toBe(groupId === bat ? 100_000 : 50_000); // concept: actuele fee
      await call("POST", `/quotes/${q.id}/send`);
      return (await call("GET", `/quotes/${q.id}`)).json();
    };
    expect((await quote(bat, "BAT-F")).feeBasisPoints).toBe(1000);
    expect((await quote(zp, "ZP-F")).feeBasisPoints).toBe(500);
  });
});
