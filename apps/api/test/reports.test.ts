import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { projects } from "../src/modules/projects/schema.js";
import { adminSession, createTestContext, makeUser, loginWithMfa, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

let groupId: string;
let projectId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  const [ch] = await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
  await api("PATCH", `/sales-channels/${ch!.id}`, { feeBasisPoints: 1000 });
  // Pakket met inkoopprijs, zodat de kostprijs bekend is
  const supplier = (await api("POST", "/organizations", { name: "Leverancier", type: "supplier" })).json().id;
  const pkg = (await api("POST", "/products", { code: "BAT", name: "Batterij", productGroupId: groupId, type: "package", vatCode: "hoog", defaultSupplierOrganizationId: supplier })).json().id;
  await api("POST", `/products/${pkg}/sales-prices`, { scopeId: ch!.id, priceCents: 1_000_000, validFrom: todayIso() });
  await api("POST", `/products/${pkg}/purchase-prices`, { scopeId: supplier, priceCents: 600_000, validFrom: todayIso() });
  const c = (await api("POST", "/customers", { lastName: "Rapport", email: "r@example.nl", property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
  const q = (await api("POST", "/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId: ch!.id })).json();
  await api("POST", `/quotes/${q.id}/lines`, { productId: pkg, quantity: 1 });
  await api("POST", `/quotes/${q.id}/send`);
  projectId = (await api("POST", `/quotes/${q.id}/accept`, { acceptedByName: "R", method: "email" })).json().projectId;
  // Twee statuswissels; de eerste "20 dagen geleden"
  const journey = (await api("GET", `/journeys/${groupId}`)).json() as { id: string; key: string }[];
  await api("POST", `/projects/${projectId}/status`, { toStatusId: journey.find((s) => s.key === "schouw_inplannen")!.id });
  await ctx.db.execute(sql`UPDATE project_status_history SET changed_at = now() - interval '20 days' WHERE project_id = ${projectId}`);
  await ctx.db.update(projects).set({ statusChangedAt: sql`now() - interval '20 days'` }).where(eq(projects.id, projectId));
  await api("POST", `/projects/${projectId}/invoices`, { type: "deposit" });
});
afterAll(async () => ctx.close());

describe("rapportages", () => {
  it("doorlooptijd, blijven hangen, marge, installateurs en cashflow", async () => {
    const res = await api("GET", "/reports/overview");
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();

    const group = r.leadTimes.find((g: { productGroup: { id: string } }) => g.productGroup.id === groupId);
    const start = group.statuses.find((s: { name: string }) => s.name === "Offerte getekend");
    expect(start.done).toBe(1);
    const now = group.statuses.find((s: { name: string }) => s.name === "Schouw in te plannen");
    expect(now.current).toBe(1);
    expect(now.currentAvgDays).toBeGreaterThan(19);
    // Statussen zonder projecten tellen niet als "nu in status"
    expect(group.statuses.find((s: { name: string }) => s.name === "Wacht op financiering").current).toBe(0);

    expect(r.stuck.map((s: { projectId: string }) => s.projectId)).toContain(projectId);
    expect(r.stuck[0].days).toBeGreaterThanOrEqual(20);

    // € 10.000 omzet, € 6.000 kostprijs, € 1.000 fee → € 3.000 marge (30%)
    const pg = r.margins.productGroups.find((m: { key: string }) => m.key === groupId);
    expect(pg).toMatchObject({ projects: 1, revenueCents: 1_000_000, costCents: 600_000, feeCents: 100_000, marginCents: 300_000, marginBasisPoints: 3000, incompleteQuotes: 0 });
    expect(r.margins.channels[0].name).toBe("Greenteam");
    expect(r.margins.partners[0].name).toBe("Nog geen partner");

    expect(Array.isArray(r.partners)).toBe(true);

    // Aanbetaling 70% van € 12.100 open; rest (30%) nog te factureren zonder geplande installatie
    expect(r.cashflow.weeks).toHaveLength(8);
    const receivable = r.cashflow.weeks.reduce((s: number, w: { receivablesCents: number }) => s + w.receivablesCents, 0) + r.cashflow.laterInCents;
    expect(receivable).toBe(847_000);
    expect(r.cashflow.unplannedCents).toBe(363_000);
  });

  it("marge alleen met recht op inkoopprijzen; periodefilter werkt", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const mh = (await loginWithMfa(ctx.app, u.email)).headers;
    const r = (await api("GET", "/reports/overview", undefined, mh)).json();
    expect(r.leadTimes).toBeTruthy();
    // Medewerker heeft (afhankelijk van de rolinrichting) misschien geen inkoopprijzen: dan geen marge
    if (!(await api("GET", "/auth/me", undefined, mh)).json().permissions.includes("purchase_prices.read")) expect(r.margins).toBeNull();

    const past = (await api("GET", "/reports/overview?from=2020-01-01&to=2020-12-31")).json();
    expect(past.margins.productGroups).toHaveLength(0);
  });
});
