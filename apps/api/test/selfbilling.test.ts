import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { auditLog } from "../src/modules/audit/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { organizations } from "../src/modules/organizations/schema.js";
import { partnerPenalties } from "../src/modules/planning/schema.js";
import { selfBillingInvoices, selfBillingLines } from "../src/modules/selfbilling/schema.js";
import { createUser } from "../src/modules/users/service.js";
import { systemActor } from "../src/lib/context.js";
import { adminSession, createTestContext, PASSWORD, roleId, type TestContext, partnerPayload } from "./helpers.js";

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
  partnerId = (await api("POST", "/organizations", await partnerPayload(ctx.db, "Installatie Noord", { email: "noord@example.nl" }))).json().id;
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
    expect(sent?.html).toContain("akkoord geven");
    expect(await openFor(partnerId)).toBeUndefined();
  });

  it("ontvanger moet accorderen vóór uitbetaling; akkoord en niet-akkoord worden gelogd", async () => {
    const [inv] = await ctx.db.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.partnerOrganizationId, partnerId));
    expect(inv!.approvalStatus).toBe("pending");
    expect((await api("POST", `/selfbilling/${inv!.id}/paid`, { paidAt: todayIso() })).json().error.code).toBe("not_approved");

    const tokenFrom = () => mail.sent.filter((m) => m.to === "noord@example.nl").at(-1)!.text.match(/selfbilling-akkoord\/([\w-]+)/)![1]!;
    const pub = (method: "GET" | "POST", url: string, payload?: unknown) =>
      ctx.app.inject({ method, url: `/api/public/selfbilling${url}`, payload: payload as object, headers: { "user-agent": "TestBrowser/1.0" } });

    const first = tokenFrom();
    const view = (await pub("GET", `/${first}`)).json();
    expect(view).toMatchObject({ number: inv!.number, approval: { status: "pending" } });
    expect(view.approvalTokenHash).toBeUndefined();

    // Niet akkoord: reden verplicht, Gecko krijgt een seintje
    expect((await pub("POST", `/${first}/decision`, { decision: "dispute", name: "Jan Noord" })).statusCode).toBe(400);
    const disputed = (await pub("POST", `/${first}/decision`, { decision: "dispute", name: "Jan Noord", reason: "Meerwerk klopt niet" })).json();
    expect(disputed.approval).toMatchObject({ status: "disputed", disputeReason: "Meerwerk klopt niet" });
    expect(mail.sent.some((m) => m.subject.startsWith("Niet akkoord"))).toBe(true);

    // Opnieuw ter akkoord: oude link vervalt
    await api("POST", `/selfbilling/${inv!.id}/request-approval`);
    expect((await pub("GET", `/${first}`)).statusCode).toBe(404);
    const second = tokenFrom();
    const ok = await pub("POST", `/${second}/decision`, { decision: "approve", name: "Jan Noord" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().approval).toMatchObject({ status: "approved", approvedByName: "Jan Noord", method: "email_link" });
    // Link blijft bruikbaar om het akkoord terug te zien, maar nogmaals beslissen kan niet
    expect((await pub("GET", `/${second}`)).json().approval.status).toBe("approved");
    expect((await pub("POST", `/${second}/decision`, { decision: "dispute", name: "Jan Noord", reason: "toch niet" })).json().error.code).toBe("already_approved");

    const [after] = await ctx.db.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.id, inv!.id));
    expect(after!.approvalEvidence).toMatchObject({ method: "email_link", userAgent: "TestBrowser/1.0", sentTo: "noord@example.nl", contentHash: inv!.contentHash, name: "Jan Noord" });
    // Akkoord ligt vast in de database
    await expect(ctx.db.update(selfBillingInvoices).set({ approvedByName: "Iemand anders" }).where(eq(selfBillingInvoices.id, inv!.id))).rejects.toThrow();
    const actions = (await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, inv!.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["selfbilling.disputed", "selfbilling.approved"]));
  });

  it("partnerportaal: eigen facturen; akkoord via inloggen-als geblokkeerd buiten testmodus", async () => {
    const u = await createUser(ctx.db, systemActor(), {
      organizationId: partnerId, email: "noord1@test.example", name: "Jan Noord", password: PASSWORD,
      roleIds: [await roleId(ctx.db, "installatiepartner")], mustChangePassword: false, mfaRequired: false,
    });
    const [inv] = await ctx.db.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.partnerOrganizationId, partnerId));
    // Als partner zelf
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "noord1@test.example", password: PASSWORD } });
    const ph = { authorization: `Bearer ${login.json().token}` };
    const list = (await ctx.app.inject({ method: "GET", url: "/api/partner/selfbilling", headers: ph })).json();
    expect(list.map((i: { id: string }) => i.id)).toEqual([inv!.id]);
    expect(list[0].approvalStatus).toBe("approved");
    // Als beheerder via inloggen-als
    const imp = await api("POST", `/users/${u.id}/impersonate`);
    const cookie = imp.cookies.find((c) => c.name === "gecko_session")!.value;
    const res = await ctx.app.inject({ method: "POST", url: `/api/partner/selfbilling/${inv!.id}/decision`, headers: { cookie: `gecko_session=${cookie}` }, payload: { decision: "approve", name: "Beheerder" } });
    expect(res.json().error.code).toBe("impersonation_not_allowed");
  });

  it("definitief is onveranderbaar; betaald markeren; export en partnerportaal", async () => {
    const [inv] = await ctx.db.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.partnerOrganizationId, partnerId));
    await expect(ctx.db.update(selfBillingInvoices).set({ totalCents: 1 }).where(eq(selfBillingInvoices.id, inv!.id))).rejects.toThrow();
    await expect(ctx.db.delete(selfBillingLines).where(eq(selfBillingLines.invoiceId, inv!.id))).rejects.toThrow();
    expect((await api("DELETE", `/selfbilling/${inv!.id}`)).json().error.code).toBe("not_draft");

    const paid = (await api("POST", `/selfbilling/${inv!.id}/paid`, { paidAt: todayIso() })).json();
    expect(paid.status).toBe("paid");
    // Zonder akkoord kan ook de database niet naar "betaald"
    const [gt] = await ctx.db.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.partnerOrganizationId, greenteamId));
    await expect(ctx.db.update(selfBillingInvoices).set({ status: "paid", paidAt: todayIso() }).where(eq(selfBillingInvoices.id, gt!.id))).rejects.toThrow();

    const csv = (await api("GET", `/selfbilling/export.csv?from=${todayIso()}&to=${todayIso()}`)).body;
    expect(csv).toContain(inv!.number!);
    expect(csv).toContain("Verlegd");

    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, partnerId));
    expect(org!.selfBillingPrefix).toBe("INS");
  });

  it("nacalculatie project: voor (offerte) naast na (facturen en selfbilling)", async () => {
    const c = (await api("GET", `/projects/${projectId}/calculation`)).json();
    const comp = (k: string) => c.components.find((x: { key: string }) => x.key === k);
    expect(comp("revenue")).toMatchObject({ plannedCents: 1_050_000, actualCents: 1_050_000, basis: "actual" });
    expect(comp("partner")).toMatchObject({ plannedCents: -170_000, actualCents: -170_000, basis: "actual" });
    // Fee was bij versturen nog niet ingesteld (voor = 0); werkelijk via selfbilling 10%
    expect(comp("fee")).toMatchObject({ plannedCents: 0, actualCents: -105_000, basis: "actual" });
    expect(c.planned.marginCents).toBe(880_000);
    expect(c.actual.marginCents).toBe(775_000);
    expect(c.deviationCents).toBe(-105_000);
    expect(c.complete).toBe(true);
    expect(c.missing).toContain("inkoopprijs BAT");
  });
});
