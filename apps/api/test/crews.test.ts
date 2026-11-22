import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { addDays } from "../src/modules/planning/service.js";
import { users } from "../src/modules/auth/schema.js";
import { adminSession, createTestContext, makeUser, type TestContext } from "./helpers.js";

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

describe("meerdere monteurs en planvoorstel (B87)", () => {
  it("met 2 monteurs passen 2 schouwen op hetzelfde moment, een derde niet; voorstel houdt rekening met rijtijd", async () => {
    const a = await scenario();
    const b = await scenario();
    const c = await scenario();
    const date = addDays(todayIso(), 3);
    const techs = (await call("GET", `/planning/technicians?partnerId=${a.partnerId}`)).json() as { id: string }[];
    const plan = (projectId: string, technicianId: string) => call("POST", `/projects/${projectId}/appointments`, { type: "survey", date, technicianId, startMinute: 480 });

    expect((await plan(a.projectId, techs[0]!.id)).statusCode).toBe(201);
    expect((await plan(b.projectId, techs[0]!.id)).json().error.code).toBe("no_capacity");

    // Tweede monteur met dezelfde beschikbaarheid
    const u = await makeUser(ctx.db, ["monteur"]);
    await ctx.db.update(users).set({ organizationId: a.partnerId, isTechnician: true }).where(eq(users.id, u.id));
    await call("PUT", "/planning/availability", { partnerId: a.partnerId, technicianId: u.id, changes: ["08", "10", "12", "14"].map((part) => ({ date, part, available: true })) });
    expect((await plan(b.projectId, u.id)).statusCode).toBe(201);
    expect((await plan(c.projectId, u.id)).json().error.code).toBe("no_capacity");

    const blocks = (await call("GET", `/planning/availability?from=${date}&to=${date}&partnerId=${a.partnerId}`)).json();
    expect(blocks.filter((x: { part: string; appointmentId: string | null }) => x.part === "08" && x.appointmentId)).toHaveLength(2);

    // Voorstel voor c: niet om 08:00 die dag; wel direct erna (zelfde adres, korte rijtijd), met uitleg
    const s = (await call("GET", `/planning/slots?projectId=${c.projectId}&type=survey`)).json();
    expect(s.suggestions.length).toBeGreaterThan(0);
    expect(s.suggestions[0].reasons.length).toBeGreaterThan(0);
    expect(s.suggestions.some((x: { date: string; startMinute: number }) => x.date === date && x.startMinute === 480)).toBe(false);
    const sameDay = s.slots.find((x: { date: string; startMinute: number }) => x.date === date && x.startMinute > 480);
    expect(sameDay.travelBefore).toBe(5);
  });
});
