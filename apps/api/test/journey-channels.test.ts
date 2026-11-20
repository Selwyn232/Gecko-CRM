import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productGroups, salesChannelProductGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

// B80: klantreis per verkoopkanaal (eigen kopie van de standaard, per productgroep).
let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let greenteam: string;
let web: string;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  greenteam = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam")))[0]!.id;
  web = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
});
afterAll(() => ctx.close());

const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });

async function project(salesChannelId: string) {
  const c = (await api("POST", "/customers", { firstName: "Kees", lastName: "Kanaal", property: { street: "Laan", houseNumber: "1", postalCode: "3511AB", city: "Utrecht" } })).json();
  const res = await api("POST", "/projects", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe("klantreis per verkoopkanaal", () => {
  it("eigen klantreis = kopie van de standaard, met overgangen en klantberichten", async () => {
    const std = (await api("GET", `/journeys/${groupId}`)).json();
    const res = await api("POST", `/journeys/${groupId}/channels/${greenteam}`);
    expect(res.statusCode, res.body).toBe(201);
    const own = res.json();
    expect(own.map((s: { key: string }) => s.key)).toEqual(std.map((s: { key: string }) => s.key));
    expect(own.every((s: { salesChannelId: string }) => s.salesChannelId === greenteam)).toBe(true);
    expect(own.filter((s: { isInitial: boolean }) => s.isInitial)).toHaveLength(1);
    // Overgangen wijzen naar statussen in de eigen klantreis
    const ownIds = new Set(own.map((s: { id: string }) => s.id));
    for (const s of own) for (const n of s.nextStatusIds) expect(ownIds.has(n)).toBe(true);
    // Twee keer kan niet
    expect((await api("POST", `/journeys/${groupId}/channels/${greenteam}`)).json().error.code).toBe("channel_journey_exists");
    // Overzicht toont standaard + kanaal
    const list = (await api("GET", "/journeys")).json().filter((j: { productGroup: { id: string } }) => j.productGroup.id === groupId);
    expect(list.map((j: { salesChannel: { id: string } | null }) => j.salesChannel?.id ?? null)).toEqual([null, greenteam]);
    // Klantberichten: eigen tabblad
    const msgs = (await api("GET", "/message-templates")).json();
    expect(msgs.groups.some((g: { salesChannel: { id: string } | null }) => g.salesChannel?.id === greenteam)).toBe(true);
  });

  it("aanpassen van de kanaalklantreis raakt de standaard niet; nieuwe projecten volgen hun kanaal", async () => {
    const own = (await api("GET", `/journeys/${groupId}?salesChannelId=${greenteam}`)).json();
    const ownStart = own.find((s: { isInitial: boolean }) => s.isInitial);
    expect((await api("PATCH", `/journey-statuses/${ownStart.id}`, { name: "Order binnen via Greenteam" })).statusCode).toBe(200);
    // Extra status alleen voor Greenteam
    const extra = await api("POST", `/journeys/${groupId}/statuses`, { key: "controle_greenteam", name: "Controle Greenteam-order", phase: "Verkoop", salesChannelId: greenteam });
    expect(extra.statusCode, extra.body).toBe(201);
    const std = (await api("GET", `/journeys/${groupId}`)).json();
    expect(std.some((s: { key: string }) => s.key === "controle_greenteam")).toBe(false);
    expect(std.find((s: { isInitial: boolean }) => s.isInitial).name).not.toBe("Order binnen via Greenteam");

    const pg = await project(greenteam);
    expect(pg.status.id).toBe(ownStart.id);
    const pw = await project(web);
    expect(pw.status.id).toBe(std.find((s: { isInitial: boolean }) => s.isInitial).id);

    // Een status uit een andere klantreis kan niet worden gekozen
    const stdNext = std.find((s: { id: string }) => s.id === pw.status.id).nextStatusIds[0];
    const wrong = await api("POST", `/projects/${pg.id}/status`, { toStatusId: stdNext, expectedStatusId: pg.status.id });
    expect(wrong.json().error.code).toBe("invalid_status");

    // Annuleren gebruikt de "geannuleerd"-status van de eigen klantreis
    const res = await api("POST", `/projects/${pg.id}/cancel`, { reason: "Klant ziet ervan af", creditInvoiceIds: [] });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await api("GET", `/projects/${pg.id}`)).json();
    expect(after.status.key).toBe("geannuleerd");
    expect(own.some((s: { id: string }) => s.id === after.status.id)).toBe(true);
  });

  it("verwijderen kan alleen zolang geen project de kanaalklantreis gebruikt", async () => {
    expect((await api("DELETE", `/journeys/${groupId}/channels/${greenteam}`)).json().error.code).toBe("journey_in_use");
    const created = await api("POST", `/journeys/${groupId}/channels/${web}`);
    expect(created.statusCode).toBe(201);
    expect((await api("DELETE", `/journeys/${groupId}/channels/${web}`)).statusCode).toBe(204);
    expect((await api("GET", `/journeys/${groupId}?salesChannelId=${web}`)).json()).toEqual([]);
  });

  it("alleen voor kanalen die de productgroep verkopen", async () => {
    const [isolatie] = await ctx.db.select().from(productGroups).where(eq(productGroups.key, "isolatie"));
    await ctx.db
      .delete(salesChannelProductGroups)
      .where(and(eq(salesChannelProductGroups.salesChannelId, web), eq(salesChannelProductGroups.productGroupId, isolatie!.id)));
    expect((await api("POST", `/journeys/${isolatie!.id}/channels/${web}`)).json().error.code).toBe("product_group_not_in_channel");
  });
});
