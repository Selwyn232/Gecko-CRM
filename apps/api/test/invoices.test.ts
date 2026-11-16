import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { outboxEvents } from "../src/modules/events/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { runDunning } from "../src/modules/invoices/dunning.js";
import { invoices } from "../src/modules/invoices/schema.js";
import { wikCollectionCosts } from "../src/modules/invoices/wik.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let channelId: string;
let pkgId: string;
let extraId: string;

const api = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });
const pub = (method: "GET" | "POST", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api/public${url}`, payload: payload as object });
const addDays = (iso: string, d: number) => {
  const x = new Date(`${iso}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

/** Klant + geaccepteerde offerte (€10.000 pakket 21% + 2× €250 meerwerk 9%) → project. */
async function acceptedProject(lastName: string) {
  const c = (await api("POST", "/customers", { lastName, email: `${lastName.toLowerCase()}@example.nl`, property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
  const q = (await api("POST", "/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId: channelId })).json();
  await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
  await api("POST", `/quotes/${q.id}/lines`, { productId: extraId, quantity: 2 });
  await api("POST", `/quotes/${q.id}/send`);
  const accepted = (await api("POST", `/quotes/${q.id}/accept`, { acceptedByName: lastName, method: "email" })).json();
  return { customer: c, projectId: accepted.projectId as string };
}

async function moveTo(projectId: string, ...keys: string[]) {
  const journey = (await api("GET", `/journeys/${groupId}`)).json() as { id: string; key: string }[];
  for (const k of keys) {
    const res = await api("POST", `/projects/${projectId}/status`, { toStatusId: journey.find((s) => s.key === k)!.id });
    expect(res.statusCode, res.body).toBe(200);
  }
}

const invoicesFor = async (projectId: string) => (await api("GET", `/invoices?projectId=${projectId}`)).json();

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  pkgId = (await api("POST", "/products", { code: "BAT", name: "Batterij", productGroupId: groupId, type: "package", vatCode: "hoog" })).json().id;
  extraId = (await api("POST", "/products", { code: "MW", name: "Meerwerk", productGroupId: groupId, type: "extra_work", vatCode: "laag" })).json().id;
  await api("POST", `/products/${pkgId}/sales-prices`, { scopeId: channelId, priceCents: 1_000_000, validFrom: todayIso() });
  await api("POST", `/products/${extraId}/sales-prices`, { scopeId: channelId, priceCents: 25_000, validFrom: todayIso() });
});
afterAll(async () => ctx.close());

describe("WIK-incassokosten", () => {
  it("volgt de wettelijke staffel met minimum en maximum", () => {
    expect(wikCollectionCosts(10_000)).toBe(4_000); // €100 → minimum €40
    expect(wikCollectionCosts(250_000)).toBe(37_500); // €2.500 → 15%
    expect(wikCollectionCosts(500_000)).toBe(62_500); // + 10% over €2.500
    expect(wikCollectionCosts(1_000_000)).toBe(87_500); // + 5% over €5.000
    expect(wikCollectionCosts(1_000_000_000)).toBe(677_500); // maximum
  });
});

describe("facturatie", () => {
  it("status 'schouw ingepland' maakt en verstuurt automatisch de aanbetalingsfactuur (70%)", async () => {
    const { projectId } = await acceptedProject("Aanbetaling");
    await moveTo(projectId, "schouw_inplannen", "schouw_ingepland");
    await processOutbox(ctx.db, ctx.app.billing);
    await processOutbox(ctx.db, ctx.app.billing); // tweede keer: geen dubbele factuur

    const list = await invoicesFor(projectId);
    expect(list).toHaveLength(1);
    const inv = (await api("GET", `/invoices/${list[0].id}`)).json();
    expect(inv.type).toBe("deposit");
    expect(inv.number).toMatch(new RegExp(`^F${todayIso().slice(0, 4)}-\\d{6}$`));
    // 70% van 10.000 (21%) + 70% van 500 (9%)
    expect(inv.subtotalCents).toBe(700_000 + 35_000);
    expect(inv.vatCents).toBe(147_000 + 3_150);
    expect(inv.dueDate).toBe(addDays(todayIso(), 14));
    expect(inv.lines.map((l: { productCode: string }) => l.productCode)).toEqual(["BAT", "MW"]);
    expect(inv.emails[0].template).toBe("invoice.deposit");
    expect(mail.sent.at(-1)!.to).toBe("aanbetaling@example.nl");
  });

  it("online betalen in testmodus zet de factuur op betaald", async () => {
    const { projectId } = await acceptedProject("Betaler");
    await api("POST", `/projects/${projectId}/invoices`, { type: "deposit" });
    const token = /\/factuur\/([\w-]+)/.exec(mail.sent.at(-1)!.text)![1]!;
    const view = (await pub("GET", `/invoices/${token}`)).json();
    expect(view.outstandingCents).toBe(view.totalCents);
    const pay = (await pub("POST", `/invoices/${token}/pay`)).json();
    expect(pay.checkoutUrl).toMatch(/\/testbetaling\//);
    const paymentId = pay.checkoutUrl.split("/").pop();
    await pub("POST", `/test-payments/${paymentId}`, { result: "paid" });
    await pub("POST", `/test-payments/${paymentId}`, { result: "paid" }); // idempotent
    const after = (await pub("GET", `/invoices/${token}`)).json();
    expect(after.status).toBe("paid");
    expect(after.paidCents).toBe(view.totalCents);
    const [paid] = await ctx.db.select().from(outboxEvents).where(and(eq(outboxEvents.type, "invoice.paid"), eq(outboxEvents.aggregateId, (await invoicesFor(projectId))[0].id)));
    expect(paid).toBeTruthy();
  });

  it("eindfactuur: volledige offerte minus aanbetaling per btw-tarief", async () => {
    const { projectId } = await acceptedProject("Eind");
    await api("POST", `/projects/${projectId}/invoices`, { type: "deposit" });
    const res = (await api("POST", `/projects/${projectId}/invoices`, { type: "final" })).json();
    const inv = (await api("GET", `/invoices/${res.invoiceId}`)).json();
    expect(inv.subtotalCents).toBe(300_000 + 15_000);
    expect(inv.vatCents).toBe(63_000 + 1_350);
    expect(inv.lines.filter((l: { lineTotalCents: number }) => l.lineTotalCents < 0)).toHaveLength(2);
  });

  it("factuurnummers lopen door zonder gaten", async () => {
    const rows = await ctx.db.select({ number: invoices.number }).from(invoices).where(sql`${invoices.number} is not null`);
    const nums = rows.map((r) => Number(r.number!.split("-")[1])).sort((a, b) => a - b);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it("definitieve factuur is onveranderbaar in de database", async () => {
    const [inv] = await ctx.db.select().from(invoices).where(sql`${invoices.number} is not null`).limit(1);
    await expect(ctx.db.update(invoices).set({ totalCents: 1 }).where(eq(invoices.id, inv!.id))).rejects.toThrow();
    await expect(ctx.db.delete(invoices).where(eq(invoices.id, inv!.id))).rejects.toThrow();
  });

  it("creditnota keert de factuur volledig om", async () => {
    const { projectId } = await acceptedProject("Credit");
    const { invoiceId } = (await api("POST", `/projects/${projectId}/invoices`, { type: "deposit", send: false })).json();
    const orig = (await api("GET", `/invoices/${invoiceId}`)).json();
    const credit = (await api("POST", `/invoices/${invoiceId}/credit`, { reason: "Klant annuleert" })).json();
    expect(credit.type).toBe("credit");
    expect(credit.totalCents).toBe(-orig.totalCents);
    expect((await api("GET", `/invoices/${invoiceId}`)).json().status).toBe("credited");
    // Na creditering kan opnieuw een aanbetalingsfactuur worden gemaakt
    expect((await api("POST", `/projects/${projectId}/invoices`, { type: "deposit", send: false })).json().created).toBe(true);
  });

  it("deelbetaling houdt de factuur open", async () => {
    const { projectId } = await acceptedProject("Deel");
    const { invoiceId } = (await api("POST", `/projects/${projectId}/invoices`, { type: "deposit", send: false })).json();
    const inv = (await api("POST", `/invoices/${invoiceId}/payments`, { amountCents: 100_000, method: "bank_transfer" })).json();
    expect(inv.status).toBe("open");
    expect(inv.outstandingCents).toBe(inv.totalCents - 100_000);
  });

  it("aanmaanflow: herinnering → 14-dagenbrief met WIK-kosten → incasso; pauze slaat over", async () => {
    const { projectId } = await acceptedProject("Wanbetaler");
    const { invoiceId } = (await api("POST", `/projects/${projectId}/invoices`, { type: "deposit" })).json();
    const inv = (await api("GET", `/invoices/${invoiceId}`)).json();
    const due = inv.dueDate as string;

    await runDunning(ctx.db, ctx.app.billing, due); // op de vervaldatum zelf: nog niets
    expect((await api("GET", `/invoices/${invoiceId}`)).json().dunningStage).toBe("none");

    await runDunning(ctx.db, ctx.app.billing, addDays(due, 1));
    let cur = (await api("GET", `/invoices/${invoiceId}`)).json();
    expect(cur.dunningStage).toBe("reminder");
    expect(mail.sent.at(-1)!.subject).toContain("Herinnering");
    await runDunning(ctx.db, ctx.app.billing, addDays(due, 2)); // binnen termijn: niets nieuws
    expect((await api("GET", `/invoices/${invoiceId}`)).json().dunning).toHaveLength(1);

    await runDunning(ctx.db, ctx.app.billing, addDays(due, 7));
    cur = (await api("GET", `/invoices/${invoiceId}`)).json();
    expect(cur.dunningStage).toBe("formal_notice");
    expect(mail.sent.at(-1)!.text).toContain("14 dagen");
    expect(cur.dunning[0].collectionCostsCents).toBe(wikCollectionCosts(cur.totalCents));

    await runDunning(ctx.db, ctx.app.billing, addDays(due, 7 + 16));
    expect((await api("GET", `/invoices/${invoiceId}`)).json().dunningStage).toBe("collection");

    // Pauze
    const { projectId: p2 } = await acceptedProject("Klager");
    const { invoiceId: i2 } = (await api("POST", `/projects/${p2}/invoices`, { type: "deposit", send: false })).json();
    await api("POST", `/invoices/${i2}/dunning-pause`, { reason: "Klacht in behandeling" });
    const d2 = (await api("GET", `/invoices/${i2}`)).json().dueDate;
    await runDunning(ctx.db, ctx.app.billing, addDays(d2, 30));
    expect((await api("GET", `/invoices/${i2}`)).json().dunningStage).toBe("none");
  });

  it("export voor Exact bevat één regel per factuur per btw-tarief", async () => {
    const res = await api("GET", `/invoices/export.csv?from=${todayIso()}&to=${todayIso()}`);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toContain("Factuurnummer");
    expect(lines.length).toBeGreaterThan(5);
  });

  it("instellingen: betaaltermijn aanpasbaar, ongeldige waarde geweigerd", async () => {
    expect((await api("PUT", "/settings/dunning.formal_term_days", { value: 7 })).statusCode).toBe(400);
    expect((await api("PUT", "/settings/invoice.payment_term_days", { value: 21 })).statusCode).toBe(200);
    const { projectId } = await acceptedProject("Termijn");
    const { invoiceId } = (await api("POST", `/projects/${projectId}/invoices`, { type: "deposit", send: false })).json();
    expect((await api("GET", `/invoices/${invoiceId}`)).json().dueDate).toBe(addDays(todayIso(), 21));
    await api("PUT", "/settings/invoice.payment_term_days", { value: 14 });
  });
});
