import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { organizations } from "../src/modules/organizations/schema.js";
import { partnerPenalties } from "../src/modules/planning/schema.js";
import { selfBillingInvoices, selfBillingLines } from "../src/modules/selfbilling/schema.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });

let groupId: string;
let channelId: string;
let greenteamId: string;
let partnerId: string;
let projectId: string;

type Open = { partner: { id: string }; items: { kind: string; amountCents: number | null; advisorName: string | null; missing: string | null }[]; penalties: unknown[] }[];
const openFor = async (pid: string) => ((await api("GET", "/selfbilling/open")).json() as Open).find((o) => o.partner.id === pid);

async function payInvoice(type: "deposit" | "final") {
  const res = await api("POST", `/projects/${projectId}/invoices`, { type });
  expect(res.statusCode, res.body).toBeLessThan(300);
  const inv = (await api("GET", `/invoices/${res.json().invoiceId}`)).json();
  const pay = await api("POST", `/invoices/${inv.id}/payments`, { amountCents: inv.totalCents, method: "bank_transfer" });
  expect(pay.statusCode, pay.body).toBeLessThan(300);
}

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  const [ch] = await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
  channelId = ch!.id;
  greenteamId = ch!.salesPartnerOrganizationId!;
  partnerId = (await api("POST", "/organizations", { name: "Installatie Noord", type: "installation_partner", email: "noord@example.nl" })).json().id;
  const advisor = (await api("POST", "/advisors", { organizationId: greenteamId, name: "Piet Adviseur" })).json();

  const pkg = (await api("POST", "/products", { code: "BAT", name: "Batterij", productGroupId: groupId, type: "package", vatCode: "hoog" })).json().id;
  const extra = (await api("POST", "/products", { code: "MW", name: "Meerwerk", productGroupId: groupId, type: "extra_work", vatCode: "laag" })).json().id;
  await api("POST", `/products/${pkg}/sales-prices`, { scopeId: channelId, priceCents: 1_000_000, validFrom: todayIso() });
  await api("POST", `/products/${extra}/sales-prices`, { scopeId: channelId, priceCents: 25_000, validFrom: todayIso() });
  // Vaste partnerprijs op het pakket en tarief voor meerwerk
  expect((await api("POST", `/products/${pkg}/partner-rates`, { scopeId: partnerId, priceCents: 150_000, validFrom: todayIso() })).statusCode).toBe(201);
  await api("POST", `/products/${extra}/partner-rates`, { scopeId: partnerId, priceCents: 10_000, validFrom: todayIso() });

  const c = (await api("POST", "/customers", { lastName: "Selfbill", email: "sb@example.nl", property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
  const q = (await api("POST", "/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId: channelId, advisorId: advisor.id })).json();
  await api("POST", `/quotes/${q.id}/lines`, { productId: pkg, quantity: 1 });
  await api("POST", `/quotes/${q.id}/lines`, { productId: extra, quantity: 2 });
  await api("POST", `/quotes/${q.id}/send`); // fee nog niet ingesteld → valt terug op het kanaal
  projectId = (await api("POST", `/quotes/${q.id}/accept`, { acceptedByName: "Selfbill", method: "email" })).json().projectId;
  await api("PATCH", `/projects/${projectId}`, { installationPartnerId: partnerId });
});
afterAll(async () => ctx.close());

describe("selfbilling", () => {
  it("Greenteam-fee pas na betaalde aanbetaling; zonder fee-percentage gemeld", async () => {
    expect(await openFor(greenteamId)).toBeUndefined();
    await payInvoice("deposit");
    const open = await openFor(greenteamId);
    expect(open!.items[0]).toMatchObject({ kind: "fee", amountCents: null, advisorName: "Piet Adviseur" });
    expect(open!.items[0]!.missing).toMatch(/Fee-percentage/);
    await api("PATCH", `/sales-channels/${channelId}`, { feeBasisPoints: 1000 });
    // 10% over € 10.500 ex btw
    expect((await openFor(greenteamId))!.items[0]!.amountCents).toBe(105_000);
    // Installateur nog niet: eindfactuur niet betaald
    expect(await openFor(partnerId)).toBeUndefined();
  });

  it("Greenteam: concept → definitief met eigen nummerreeks en 21% btw; daarna niets meer open", async () => {
    const draft = (await api("POST", "/selfbilling/drafts", { partnerId: greenteamId })).json();
    expect(draft).toMatchObject({ status: "draft", vatMode: "normal", subtotalCents: 105_000, vatCents: 22_050, totalCents: 127_050 });
    const fin = await api("POST", `/selfbilling/${draft.id}/finalize`);
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json().number).toMatch(/^GRE-\d{4}-0001$/);
    expect(await openFor(greenteamId)).toBeUndefined();
  });

  it("installateur: partnerprijs + meerwerk − boete, btw verlegd; boete verrekend en mail naar partner", async () => {
    await payInvoice("final");
    await ctx.db.insert(partnerPenalties).values({ partnerOrganizationId: partnerId, amountCents: 25_000, reason: "Niet gekomen" });
    const open = await openFor(partnerId);
    expect(open!.items).toHaveLength(1);
    expect(open!.items[0]).toMatchObject({ kind: "installation", amountCents: 170_000 });
    expect(open!.penalties).toHaveLength(1);

    const draft = (await api("POST", "/selfbilling/drafts", { partnerId })).json();
    expect(draft).toMatchObject({ vatMode: "reverse_charge", subtotalCents: 145_000, vatCents: 0, totalCents: 145_000 });
    // Correctie en regel weer weghalen
    const withCorr = (await api("POST", `/selfbilling/${draft.id}/corrections`, { description: "Parkeerkosten", amountCents: 2_500, withVat: true })).json();
    expect(withCorr.totalCents).toBe(147_500);
    const corr = withCorr.lines.find((l: { kind: string }) => l.kind === "correction");
    expect((await api("DELETE", `/selfbilling/${draft.id}/lines/${corr.id}`)).json().totalCents).toBe(145_000);

    const fin = (await api("POST", `/selfbilling/${draft.id}/finalize`)).json();
    expect(fin.number).toMatch(/^INS-\d{4}-0001$/);
    const [pen] = await ctx.db.select().from(partnerPenalties).where(eq(partnerPenalties.partnerOrganizationId, partnerId));
    expect(pen!.status).toBe("settled");
    const sent = mail.sent.find((m) => m.to === "noord@example.nl");
    expect(sent?.subject).toContain(fin.number);
    expect(sent?.text).toContain("Factuur uitgereikt door afnemer");
    expect(await openFor(partnerId)).toBeUndefined();
  });

  it("definitief is onveranderbaar; betaald markeren; export en partnerportaal", async () => {
    const [inv] = await ctx.db.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.partnerOrganizationId, partnerId));
    await expect(ctx.db.update(selfBillingInvoices).set({ totalCents: 1 }).where(eq(selfBillingInvoices.id, inv!.id))).rejects.toThrow();
    await expect(ctx.db.delete(selfBillingLines).where(eq(selfBillingLines.invoiceId, inv!.id))).rejects.toThrow();
    expect((await api("DELETE", `/selfbilling/${inv!.id}`)).json().error.code).toBe("not_draft");

    const paid = (await api("POST", `/selfbilling/${inv!.id}/paid`, { paidAt: todayIso() })).json();
    expect(paid.status).toBe("paid");

    const csv = (await api("GET", `/selfbilling/export.csv?from=${todayIso()}&to=${todayIso()}`)).body;
    expect(csv).toContain(inv!.number!);
    expect(csv).toContain("Verlegd");

    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, partnerId));
    expect(org!.selfBillingPrefix).toBe("INS");
  });
});
