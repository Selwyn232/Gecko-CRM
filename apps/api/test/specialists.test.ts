import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { customers } from "../src/modules/customers/schema.js";
import { outboundEmails } from "../src/modules/email/schema.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { journeyStatuses } from "../src/modules/journeys/schema.js";
import { projects } from "../src/modules/projects/schema.js";
import { releaseIfDone } from "../src/modules/specialists/service.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, type TestContext } from "./helpers.js";

// B81: vaste klantspecialist per klant.
let ctx: TestContext;
let admin: Record<string, string>;
let groupId: string;
let a: { id: string; headers: Record<string, string> };
let b: { id: string; headers: Record<string, string> };
let manager: Record<string, string>;

const call = (headers: Record<string, string>, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

async function signedOrder(email: string) {
  const s = (await call(admin, "POST", "/testing/scenario", { productGroupId: groupId, email, postalCode: "3511 AB" })).json();
  await processOutbox(ctx.db, ctx.app.billing);
  const [p] = await ctx.db.select().from(projects).where(eq(projects.id, s.projectId));
  return { projectId: s.projectId as string, customerId: p!.customerId };
}
const specialistOf = async (customerId: string) => (await ctx.db.select().from(customers).where(eq(customers.id, customerId)))[0]!;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  await call(admin, "PUT", "/settings/test.mode", { value: true });
  const web = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  const pkg = (await call(admin, "POST", "/products", { code: "TB", name: "Batterij", productGroupId: groupId, type: "package", vatCode: "hoog" })).json();
  await call(admin, "POST", `/products/${pkg.id}/sales-prices`, { scopeId: web, priceCents: 800_000, validFrom: todayIso() });
  const ua = await makeUser(ctx.db, ["klantspecialist"]);
  const ub = await makeUser(ctx.db, ["klantspecialist"]);
  const um = await makeUser(ctx.db, ["manager_klantenservice"]);
  a = { id: ua.id, headers: (await loginWithMfa(ctx.app, ua.email)).headers };
  b = { id: ub.id, headers: (await loginWithMfa(ctx.app, ub.email)).headers };
  manager = (await loginWithMfa(ctx.app, um.email)).headers;
});
afterAll(() => ctx.close());

describe("klantspecialisten", () => {
  it("getekende order → automatisch de minst bezette specialist, met welkomstmail", async () => {
    expect((await call(manager, "PATCH", `/specialists/${a.id}`, { maxCustomers: 1 })).statusCode).toBe(200);
    const one = await signedOrder("klant1@example.nl");
    const c1 = await specialistOf(one.customerId);
    expect(c1.specialistUserId).toBe(a.id);
    const mails = await ctx.db.select().from(outboundEmails).where(and(eq(outboundEmails.customerId, one.customerId), eq(outboundEmails.template, "specialist.welcome")));
    expect(mails).toHaveLength(1);
    // A zit vol (maximum 1) → volgende klant naar B
    const two = await signedOrder("klant2@example.nl");
    expect((await specialistOf(two.customerId)).specialistUserId).toBe(b.id);
    // Dashboard van de manager
    const ov = (await call(manager, "GET", "/specialists")).json();
    const rowA = ov.specialists.find((s: { id: string }) => s.id === a.id);
    expect(rowA).toMatchObject({ customers: 1, maxCustomers: 1, utilization: 1 });
  });

  it("specialist ziet alleen eigen klanten (lijst, klantkaart, project, zoeken)", async () => {
    const mine = (await call(a.headers, "GET", "/customers")).json();
    expect(mine.items.every((c: { specialistUserId: string }) => c.specialistUserId === a.id)).toBe(true);
    const others = (await call(b.headers, "GET", "/customers")).json().items;
    const otherId = others[0].id;
    expect((await call(a.headers, "GET", `/customers/${otherId}`)).statusCode).toBe(404);
    const otherProject = (await call(b.headers, "GET", "/projects")).json().items[0];
    expect((await call(a.headers, "GET", `/projects/${otherProject.id}`)).statusCode).toBe(404);
    expect((await call(a.headers, "GET", `/projects`)).json().items.some((p: { id: string }) => p.id === otherProject.id)).toBe(false);
    expect((await call(a.headers, "POST", "/tasks", { title: "Bellen", customerId: otherId })).statusCode).toBe(404);
    expect((await call(a.headers, "GET", "/exports/klanten.csv")).statusCode).toBe(403);
    // Manager ziet alles
    expect((await call(manager, "GET", `/customers/${otherId}`)).statusCode).toBe(200);
    // Klantkaart toont de specialist
    expect((await call(manager, "GET", `/customers/${otherId}`)).json().specialist.id).toBe(b.id);
  });

  it("manager zet klanten over; klant krijgt bericht met de nieuwe specialist", async () => {
    const before = (await call(manager, "GET", `/specialists/${b.id}/customers`)).json();
    expect(before.length).toBeGreaterThan(0);
    const res = await call(manager, "POST", "/specialists/transfer", { fromUserId: b.id, toUserId: a.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moved).toBe(before.length);
    const cid = before[0].id;
    expect((await specialistOf(cid)).specialistUserId).toBe(a.id);
    const mails = await ctx.db.select().from(outboundEmails).where(and(eq(outboundEmails.customerId, cid), eq(outboundEmails.template, "specialist.transfer")));
    expect(mails).toHaveLength(1);
    // Specialist mag dit niet zelf
    expect((await call(a.headers, "POST", "/specialists/transfer", { fromUserId: a.id, toUserId: b.id })).statusCode).toBe(403);
  });

  it("na afgeronde installatie naar Service; specialist ziet de klant niet meer", async () => {
    const [c] = await ctx.db.select().from(customers).where(eq(customers.specialistUserId, a.id)).limit(1);
    const [p] = await ctx.db.select().from(projects).where(eq(projects.customerId, c!.id));
    const [done] = await ctx.db.select().from(journeyStatuses).where(and(eq(journeyStatuses.productGroupId, p!.productGroupId), eq(journeyStatuses.isFinal, true), eq(journeyStatuses.key, "afgerond")));
    await ctx.db.update(projects).set({ statusId: done!.id }).where(eq(projects.id, p!.id));
    await releaseIfDone(ctx.db, p!.id);
    const after = await specialistOf(c!.id);
    expect(after.specialistUserId).toBeNull();
    expect(after.serviceSince).not.toBeNull();
    expect((await call(a.headers, "GET", `/customers/${c!.id}`)).statusCode).toBe(404);
  });

  it("specialist mag eigen pasfoto zetten, niet het maximum", async () => {
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    expect((await call(a.headers, "PATCH", `/specialists/${a.id}`, { photoDataUrl: photo })).statusCode).toBe(200);
    expect((await call(a.headers, "PATCH", `/specialists/${a.id}`, { maxCustomers: 99 })).statusCode).toBe(403);
    const img = await ctx.app.inject({ method: "GET", url: `/api/public/specialists/${a.id}/photo` });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
  });
  it("specialist komt niet bij overzichten en beheer (alleen eigen klanten)", async () => {
    for (const url of ["/selfbilling", "/reports/overview", "/users", "/roles"]) {
      expect((await call(a.headers, "GET", url)).statusCode, url).toBe(403);
      expect((await call(manager, "GET", url)).statusCode, url).not.toBe(403);
    }
    expect((await call(a.headers, "POST", "/regions", { name: "X", postalRanges: [[1000, 1001]] })).statusCode).toBe(403);
    // Wel: producten lezen (voor offertes) en eigen werk
    expect((await call(a.headers, "GET", "/products")).statusCode).toBe(200);
    expect((await call(a.headers, "GET", "/work")).statusCode).toBe(200);
  });
});
