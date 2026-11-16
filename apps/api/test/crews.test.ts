import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { addDays } from "../src/modules/planning/service.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });
let groupId: string;
let channelId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "isolatie")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  const pkg = (await call("POST", "/products", { code: "ISO", name: "Spouwisolatie", productGroupId: groupId, type: "package", vatCode: "laag" })).json();
  await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: channelId, priceCents: 300_000, validFrom: todayIso() });
  await call("PUT", "/settings/test.mode", { value: true });
});
afterAll(async () => ctx.close());

const scenario = async () => (await call("POST", "/testing/scenario", { productGroupId: groupId, email: "c@example.nl", postalCode: "3511 AB", salesChannelId: channelId })).json();

describe("meerdere ploegen en planvoorstel", () => {
  it("met 2 ploegen passen 2 schouwen in hetzelfde dagdeel, een derde niet", async () => {
    const a = await scenario();
    const b = await scenario();
    const c = await scenario();
    const date = addDays(todayIso(), 3);
    const plan = (projectId: string) => call("POST", `/projects/${projectId}/appointments`, { type: "survey", date, partnerId: a.partnerId, part: "morning" });

    expect((await plan(a.projectId)).statusCode).toBe(201);
    expect((await plan(b.projectId)).json().error.code).toBe("no_capacity");

    expect((await call("PATCH", `/organizations/${a.partnerId}`, { crewCount: 2 })).statusCode).toBe(200);
    expect((await plan(b.projectId)).statusCode).toBe(201);
    expect((await plan(c.projectId)).json().error.code).toBe("no_capacity");

    const blocks = (await call("GET", `/planning/availability?from=${date}&to=${date}&partnerId=${a.partnerId}`)).json();
    expect(blocks.find((x: { part: string }) => x.part === "morning")).toMatchObject({ appointmentCount: 2, capacity: 2 });

    // Voorstel voor c: niet de volle ochtend; met uitleg
    const s = (await call("GET", `/planning/slots?projectId=${c.projectId}&type=survey`)).json();
    expect(s.suggestions.length).toBeGreaterThan(0);
    expect(s.suggestions[0].reasons.length).toBeGreaterThan(0);
    expect(s.suggestions.some((x: { date: string; part: string }) => x.date === date && x.part === "morning")).toBe(false);
    // Op dezelfde dag (middag) in dezelfde buurt scoort beter dan alleen "vroegst"
    const sameDay = s.suggestions.find((x: { date: string; part: string }) => x.date === date && x.part === "afternoon");
    expect(sameDay?.reasons.join(" ")).toMatch(/in de buurt/);
  });
});
