import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { users } from "../src/modules/auth/schema.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { technicianLocations } from "../src/modules/planning/schema.js";
import { addDays } from "../src/modules/planning/service.js";
import { estimateMinutes, setTravelFetcher, travelMatrix } from "../src/modules/planning/travel.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

// B87: monteurs met eigen inlog, onderweg (ETA), aanmelden en afmelden; rijtijden via Google Maps.
const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let channelId: string;
const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

async function loginAs(userId: string) {
  const imp = await ctx.app.inject({ method: "POST", url: `/api/users/${userId}/impersonate`, headers: h });
  return { cookie: `gecko_session=${imp.cookies.find((c) => c.name === "gecko_session")!.value}` };
}

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  const pkg = (await call("POST", "/products", { code: "TB", name: "Batterij", productGroupId: groupId, type: "package", vatCode: "hoog" })).json();
  await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: channelId, priceCents: 800_000, validFrom: todayIso() });
  await call("PUT", "/settings/test.mode", { value: true });
});
afterEach(() => setTravelFetcher(null));
afterAll(() => ctx.close());

describe("rijtijden", () => {
  it("Google Maps met geheugen; zonder Google een schatting op postcode", async () => {
    expect(estimateMinutes("3511AB", "3511CD")).toBe(10);
    expect(estimateMinutes("3511AB", "9711AA")).toBe(80);
    let calls = 0;
    process.env.GOOGLE_MAPS_API_KEY = "test";
    setTravelFetcher(async (url) => {
      calls++;
      expect(url).toContain("origins=3511AB%2CNederland");
      expect(url).not.toMatch(/straat|naam/i);
      return { ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ status: "OK", duration: { value: 1260 } }] }] }) };
    });
    const m = await travelMatrix(ctx.db, ["3511 AB"], ["1234AB"]);
    expect(m.get("3511AB|1234AB")).toBe(25); // 21 min → afgerond op 5
    await travelMatrix(ctx.db, ["3511AB"], ["1234AB"]);
    expect(calls).toBe(1); // tweede keer uit het geheugen
    delete process.env.GOOGLE_MAPS_API_KEY;
  });
});

describe("monteursportaal", () => {
  it("partner voegt monteur toe; monteur ziet alleen eigen klussen, meldt onderweg (ETA naar klant), aan en af", async () => {
    const s = (await call("POST", "/testing/scenario", { productGroupId: groupId, email: "klant@example.nl", postalCode: "3511 AB", salesChannelId: channelId })).json();
    await processOutbox(ctx.db, ctx.app.billing);
    const partner = await loginAs(s.partnerUserId);
    const added = await call("POST", "/partner/technicians", { name: "Jan Monteur", email: "jan@partner.example" }, partner);
    expect(added.statusCode, added.body).toBe(201);
    expect(mail.sent.at(-1)!.subject).toMatch(/Uw account/);
    const list = (await call("GET", "/partner/technicians", undefined, partner)).json();
    expect(list.filter((t: { isTechnician: boolean }) => t.isTechnician)).toHaveLength(2);
    const jan = added.json().id as string;
    const date = addDays(todayIso(), 1);
    await call("PUT", "/partner/availability", { technicianId: jan, changes: ["08", "10"].map((part) => ({ date, part, available: true })) }, partner);

    // Planner plant de schouw bij Jan om 08:00
    const slots = (await call("GET", `/planning/slots?projectId=${s.projectId}&type=survey`)).json().slots;
    const janSlot = slots.find((x: { technicianId: string; date: string }) => x.technicianId === jan && x.date === date);
    expect(janSlot).toMatchObject({ startMinute: 480, technicianName: "Jan Monteur" });
    const appt = (await call("POST", `/projects/${s.projectId}/appointments`, { type: "survey", date, technicianId: jan, startMinute: 480 })).json();

    // Jan heeft alleen monteursrechten
    const janH = await loginAs(jan);
    expect((await call("GET", "/partner/technicians", undefined, janH)).statusCode).toBe(403);
    const day = (await call("GET", `/technician/day?date=${date}`, undefined, janH)).json();
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ id: appt.id, time: "08:00–10:00", customerName: expect.stringContaining("Klant") });
    expect((await call("GET", `/partner/appointments/${appt.id}`, undefined, janH)).statusCode).toBe(200);
    // De andere monteur van de partner ziet deze klus niet via het monteursportaal
    const [other] = await ctx.db.select().from(users).where(eq(users.id, s.partnerUserId));
    expect(other!.isTechnician).toBe(true);
    expect((await call("GET", `/technician/day?date=${date}`, undefined, partner)).json()).toHaveLength(0);

    // Onderweg: Google geeft 18 minuten → klant krijgt bericht met aankomsttijd
    process.env.GOOGLE_MAPS_API_KEY = "test";
    setTravelFetcher(async () => ({ ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ status: "OK", duration: { value: 18 * 60 } }] }] }) }));
    const er = await call("POST", `/technician/appointments/${appt.id}/en-route`, { lat: 52.09, lng: 5.12 }, janH);
    expect(er.statusCode, er.body).toBe(200);
    expect(er.json().minutes).toBe(20);
    delete process.env.GOOGLE_MAPS_API_KEY;
    const onderweg = mail.sent.at(-1)!;
    expect(onderweg.subject).toBe("Uw monteur is onderweg");
    expect(onderweg.text).toMatch(/Jan is nu onderweg naar u\. De verwachte aankomst is rond \d\d:\d\d uur/);

    expect((await call("POST", `/technician/appointments/${appt.id}/check-in`, null, janH)).statusCode).toBe(200);
    // Locatie wordt bewaard (alleen overdag); andermans klus kan niet
    await call("POST", "/technician/location", { lat: 52.1, lng: 5.1, accuracy: 15 }, janH);
    expect((await ctx.db.select().from(technicianLocations).where(eq(technicianLocations.technicianUserId, jan))).length).toBeGreaterThanOrEqual(0);
    expect((await call("POST", `/technician/appointments/${appt.id}/check-in`, null, partner)).statusCode).toBe(404);
    // Afmelden = opleveren met het rapport
    const rep = await call("POST", `/partner/appointments/${appt.id}/report`, { positive: true, data: { remarks: "klaar" } }, janH);
    expect(rep.statusCode, rep.body).toBe(200);
    const after = (await call("GET", `/technician/day?date=${date}`, undefined, janH)).json();
    expect(after[0].status).toBe("completed");
    expect(after[0].checkedOutAt).toBeTruthy();
  });
});
