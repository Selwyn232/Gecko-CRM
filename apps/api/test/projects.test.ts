import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxEvents } from "../src/modules/events/schema.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
let batteryGroupId: string;
let channelId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  batteryGroupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam")))[0]!.id;
});
afterAll(async () => ctx.close());

const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

const property = { street: "Dorpsstraat", houseNumber: "12", postalCode: "1234 ab", city: "Utrecht" };

async function customerWithProperty(lastName = "Jansen") {
  const res = await api("POST", "/customers", { firstName: "Piet", lastName, email: "Piet@Example.nl", phone: "06-12345678", property });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe("klanten en woningen", () => {
  it("maakt klant met woning; normaliseert e-mail, telefoon en postcode; klantnummer oplopend", async () => {
    const a = await customerWithProperty();
    const b = await customerWithProperty("de Vries");
    expect(a.email).toBe("piet@example.nl");
    expect(a.phone).toBe("+31612345678");
    expect(a.properties[0].postalCode).toBe("1234AB");
    expect(a.displayNumber).toMatch(/^K-\d{6}$/);
    expect(b.number).toBe(a.number + 1);
  });

  it("weigert ongeldige postcode en telefoonnummer", async () => {
    expect((await api("POST", "/customers", { lastName: "X", property: { ...property, postalCode: "0123AB" } })).json().error.code).toBe("invalid_postal_code");
    expect((await api("POST", "/customers", { lastName: "X", phone: "12" })).json().error.code).toBe("invalid_phone");
  });

  it("zoekt op naam, postcode, telefoon en klantnummer", async () => {
    const c = await customerWithProperty("Zoekmans");
    for (const q of ["zoekmans", "1234 AB", "0612345678", c.displayNumber]) {
      const res = (await api("GET", `/customers?search=${encodeURIComponent(q)}`)).json();
      expect(res.items.map((i: { id: string }) => i.id), q).toContain(c.id);
    }
  });
});

describe("projecten en klantreis", () => {
  it("elke productgroep heeft een standaard-klantreis met één startstatus", async () => {
    const journeys = (await api("GET", "/journeys")).json();
    expect(journeys).toHaveLength(4);
    for (const j of journeys) expect(j.statuses.filter((s: { isInitial: boolean }) => s.isInitial)).toHaveLength(1);
  });

  it("nieuw project start in de startstatus, met historie en gebeurtenis", async () => {
    const c = await customerWithProperty();
    const res = await api("POST", "/projects", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: batteryGroupId, salesChannelId: channelId });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json();
    expect(p.status.key).toBe("order_getekend");
    expect(p.history).toHaveLength(1);
    expect(p.displayNumber).toMatch(/^P-\d{6}$/);
    expect(p.nextStatuses.map((s: { key: string }) => s.key)).toEqual(["wacht_financiering", "schouw_inplannen", "geannuleerd"]);
    const events = await ctx.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, p.id));
    expect(events.map((e) => e.type)).toEqual(["project.created"]);
  });

  it("woning moet bij de klant horen", async () => {
    const a = await customerWithProperty();
    const b = await customerWithProperty();
    const res = await api("POST", "/projects", { customerId: a.id, propertyId: b.properties[0].id, productGroupId: batteryGroupId, salesChannelId: channelId });
    expect(res.json().error.code).toBe("invalid_property");
  });

  it("alleen toegestane statusovergangen; conflict bij verouderde status", async () => {
    const c = await customerWithProperty();
    const p = (await api("POST", "/projects", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: batteryGroupId, salesChannelId: channelId })).json();
    const journey = (await api("GET", `/journeys/${batteryGroupId}`)).json();
    const byKey = (k: string) => journey.find((s: { key: string }) => s.key === k).id;

    const skip = await api("POST", `/projects/${p.id}/status`, { toStatusId: byKey("afgerond") });
    expect(skip.json().error.code).toBe("transition_not_allowed");

    const ok = await api("POST", `/projects/${p.id}/status`, { toStatusId: byKey("schouw_inplannen"), expectedStatusId: p.statusId, note: "Geen financiering" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status.key).toBe("schouw_inplannen");
    expect(ok.json().history[0].note).toBe("Geen financiering");

    const stale = await api("POST", `/projects/${p.id}/status`, { toStatusId: byKey("schouw_ingepland"), expectedStatusId: p.statusId });
    expect(stale.json().error.code).toBe("status_changed");

    const events = await ctx.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, p.id));
    expect(events.map((e) => e.type)).toEqual(["project.created", "project.status_changed"]);
  });

  it("klantreis is aan te passen: nieuwe status en overgang", async () => {
    const journey = (await api("GET", `/journeys/${batteryGroupId}`)).json();
    const start = journey.find((s: { isInitial: boolean }) => s.isInitial);
    const created = await api("POST", `/journeys/${batteryGroupId}/statuses`, { key: "netbeheerder", name: "Aanmelding netbeheerder", phase: "Afronding" });
    expect(created.statusCode, created.body).toBe(201);
    const set = await api("PUT", `/journey-statuses/${start.id}/transitions`, { toStatusIds: [...start.nextStatusIds, created.json().id] });
    expect(set.statusCode).toBe(200);
    const after = (await api("GET", `/journeys/${batteryGroupId}`)).json();
    expect(after.find((s: { id: string }) => s.id === start.id).nextStatusIds).toContain(created.json().id);
  });

  it("status in gebruik kan niet worden verwijderd; startstatus niet uitzetbaar", async () => {
    const journey = (await api("GET", `/journeys/${batteryGroupId}`)).json();
    const start = journey.find((s: { isInitial: boolean }) => s.isInitial);
    expect((await api("DELETE", `/journey-statuses/${start.id}`)).statusCode).toBe(400);
    expect((await api("PATCH", `/journey-statuses/${start.id}`, { isActive: false })).statusCode).toBe(400);
  });

  it("projectenoverzicht filtert en zoekt; eindstatussen standaard verborgen", async () => {
    const c = await customerWithProperty("Overzichtsma");
    await api("POST", "/projects", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: batteryGroupId, salesChannelId: channelId });
    const res = (await api("GET", "/projects?search=overzichtsma")).json();
    expect(res.total).toBe(1);
    expect(res.items[0].customer.lastName).toBe("Overzichtsma");
  });

  it("planner mag projecten maar geen klantreis beheren", async () => {
    const u = await makeUser(ctx.db, ["planner"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    expect((await api("GET", "/projects", undefined, headers)).statusCode).toBe(200);
    expect((await api("POST", `/journeys/${batteryGroupId}/statuses`, { key: "x_y", name: "x", phase: "x" }, headers)).statusCode).toBe(403);
    expect((await api("POST", "/customers", { lastName: "x" }, headers)).statusCode).toBe(403);
  });
});

describe("rol medewerker", () => {
  it("mag klanten en projecten gebruiken, maar niets instellen", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    const c = await api("POST", "/customers", { lastName: "Medewerkerstest", property }, headers);
    expect(c.statusCode).toBe(201);
    const p = await api("POST", "/projects", { customerId: c.json().id, propertyId: c.json().properties[0].id, productGroupId: batteryGroupId, salesChannelId: channelId }, headers);
    expect(p.statusCode).toBe(201);
    expect((await api("GET", "/products", undefined, headers)).statusCode).toBe(200);

    expect((await api("POST", "/products", { code: "X", name: "x", productGroupId: batteryGroupId, type: "package", vatCode: "hoog" }, headers)).statusCode).toBe(403);
    expect((await api("POST", `/journeys/${batteryGroupId}/statuses`, { key: "x_y", name: "x", phase: "x" }, headers)).statusCode).toBe(403);
    expect((await api("PATCH", `/users/${u.id}`, { name: "x" }, headers)).statusCode).toBe(403);
    expect((await api("POST", "/roles", { key: "x_y", name: "x", permissions: [] }, headers)).statusCode).toBe(403);
    expect((await api("POST", "/organizations", { name: "x", type: "supplier" }, headers)).statusCode).toBe(403);
    expect((await api("POST", "/vat-codes/hoog/rates", { rateBasisPoints: 2200, validFrom: "2099-01-01" }, headers)).statusCode).toBe(403);
  });
});
