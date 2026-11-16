import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemActor } from "../src/lib/context.js";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { createUser } from "../src/modules/users/service.js";
import { adminSession, createTestContext, PASSWORD, roleId, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

let gt: string;
let channelId: string;
let groupId: string;
let pkgId: string;
let advA: string;
let advB: string;

async function salesUser(username: string, advisorId: string | null) {
  await createUser(ctx.db, systemActor(), {
    organizationId: gt,
    username,
    name: username,
    password: PASSWORD,
    roleIds: [await roleId(ctx.db, "verkooppartner")],
    mustChangePassword: false,
    mfaRequired: false,
    advisorId,
  });
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: username, password: PASSWORD } });
  return { authorization: `Bearer ${res.json().token}` };
}

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  const [ch] = await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
  channelId = ch!.id;
  gt = ch!.salesPartnerOrganizationId!;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  pkgId = (await call("POST", "/products", { code: "TB1", name: "Batterij 10 kWh", productGroupId: groupId, type: "package", vatCode: "hoog" })).json().id;
  await call("POST", `/products/${pkgId}/sales-prices`, { scopeId: channelId, priceCents: 700_000, validFrom: todayIso() });
  advA = (await call("POST", "/advisors", { organizationId: gt, name: "Adviseur A" })).json().id;
  advB = (await call("POST", "/advisors", { organizationId: gt, name: "Adviseur B" })).json().id;
});
afterAll(async () => ctx.close());

describe("verkooppartnerportaal", () => {
  it("adviseur maakt klant en offerte, verstuurt hem; ziet geen kostprijs", async () => {
    const a = await salesUser("adviseur.a", advA);
    const me = (await call("GET", "/sales/me", undefined, a)).json();
    expect(me.advisors).toEqual([{ id: advA, name: "Adviseur A" }]);
    expect(me.channels[0].productGroups.map((g: { id: string }) => g.id)).toContain(groupId);
    const catalog = (await call("GET", `/sales/catalog?channelId=${channelId}&productGroupId=${groupId}`, undefined, a)).json();
    expect(catalog[0]).toMatchObject({ id: pkgId, priceCents: 700_000 });

    const c = (await call("POST", "/sales/customers", { lastName: "Verkoop", email: "verkoop@example.nl", salesChannelId: channelId, property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } }, a)).json();
    // Probeert een andere adviseur op te geven: wordt genegeerd
    const q = (await call("POST", "/sales/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId: channelId, advisorId: advB }, a)).json();
    expect(q.advisorId).toBe(advA);
    const withLine = (await call("POST", `/sales/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 }, a)).json();
    expect(withLine.lines[0].unitCostCents).toBeNull();
    expect(withLine.margin).toBeNull();
    const sent = (await call("POST", `/sales/quotes/${q.id}/send`, undefined, a)).json();
    expect(sent.status).toBe("sent");
    expect(mail.sent.at(-1)!.to).toBe("verkoop@example.nl");
    expect((await call("GET", "/sales/quotes", undefined, a)).json().map((x: { id: string }) => x.id)).toEqual([q.id]);
  });

  it("andere adviseur, organisatiebrede gebruiker en vreemde organisatie", async () => {
    const b = await salesUser("adviseur.b", advB);
    expect((await call("GET", "/sales/quotes", undefined, b)).json()).toEqual([]);
    expect((await call("GET", "/sales/customers", undefined, b)).json()).toEqual([]);
    const [quote] = (await call("GET", "/sales/quotes", undefined, await salesUser("greenteam.office", null))).json();
    expect(quote.advisor).toBe("Adviseur A");
    expect((await call("GET", `/sales/quotes/${quote.id}`, undefined, b)).statusCode).toBe(404);

    // Offerte van Gecko zelf (kanaal web) is niet zichtbaar
    const web = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
    expect((await call("GET", `/sales/catalog?channelId=${web}&productGroupId=${groupId}`, undefined, b)).statusCode).toBe(404);

    // Medewerker van Gecko heeft geen toegang tot dit portaal; adviseur niet tot het CRM
    expect((await call("GET", "/sales/me")).statusCode).toBe(403);
    expect((await call("GET", "/customers", undefined, b)).statusCode).toBe(403);
  });

  it("koppeling met API-sleutel: werkt als de koppelgebruiker; intrekken blokkeert", async () => {
    const u = await createUser(ctx.db, systemActor(), { organizationId: gt, username: "greenteam.api", name: "Greenteam koppeling", password: PASSWORD, roleIds: [await roleId(ctx.db, "verkooppartner")], mustChangePassword: false, mfaRequired: true });
    const created = await call("POST", `/users/${u.id}/api-keys`, { name: "Greenteam CRM" });
    expect(created.statusCode, created.body).toBe(201);
    const { key, id } = created.json();
    expect(key).toMatch(/^gk_/);
    const kh = { authorization: `Bearer ${key}` };
    const me = await call("GET", "/sales/me", undefined, kh);
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().organization.id).toBe(gt);
    // Alleen wat de gebruiker mag
    expect((await call("GET", "/customers", undefined, kh)).statusCode).toBe(403);
    const list = (await call("GET", `/users/${u.id}/api-keys`)).json();
    expect(list[0]).toMatchObject({ name: "Greenteam CRM" });
    expect(list[0].key).toBeUndefined();
    await call("POST", `/api-keys/${id}/revoke`);
    expect((await call("GET", "/sales/me", undefined, kh)).statusCode).toBe(401);
  });
});
