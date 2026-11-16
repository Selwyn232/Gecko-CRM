import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { regionContains } from "../src/modules/planning/service.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, PASSWORD, roleId, type TestContext } from "./helpers.js";
import { createUser } from "../src/modules/users/service.js";
import { systemActor } from "../src/lib/context.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let channelId: string;
let pkgId: string;
let extraId: string;
let regionId: string;
let partnerA: string;
let partnerB: string;
let partnerAHeaders: Record<string, string>;
let partnerBHeaders: Record<string, string>;

const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });
const flush = async () => {
  for (let i = 0; i < 5; i++) await processOutbox(ctx.db, ctx.app.billing);
};
const addDays = (iso: string, d: number) => {
  const x = new Date(`${iso}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
// Kleinste geldige JPEG-kop (magic bytes) volstaat voor de typecontrole.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

async function partnerUser(orgId: string, username: string) {
  await createUser(ctx.db, systemActor(), {
    organizationId: orgId,
    username,
    name: username,
    password: PASSWORD,
    roleIds: [await roleId(ctx.db, "installatiepartner")],
    mustChangePassword: false,
    mfaRequired: false,
  });
  const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: username, password: PASSWORD } });
  return { authorization: `Bearer ${res.json().token}` };
}

async function projectReadyForSurvey(lastName: string, postalCode = "1234AB") {
  const c = (await call("POST", "/customers", { lastName, email: `${lastName.toLowerCase()}@example.nl`, property: { street: "Weg", houseNumber: "1", postalCode, city: "Ede" } })).json();
  const q = (await call("POST", "/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groupId, salesChannelId: channelId })).json();
  await call("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
  await call("POST", `/quotes/${q.id}/send`);
  const projectId = (await call("POST", `/quotes/${q.id}/accept`, { acceptedByName: lastName, method: "email" })).json().projectId as string;
  const journey = (await call("GET", `/journeys/${groupId}`)).json() as { id: string; key: string }[];
  await call("POST", `/projects/${projectId}/status`, { toStatusId: journey.find((s) => s.key === "schouw_inplannen")!.id });
  await flush();
  return projectId;
}
const statusKey = async (projectId: string) => (await call("GET", `/projects/${projectId}`)).json().status.key as string;

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "warmtepomp")))[0]!.id;
  await call("PATCH", `/product-groups/${groupId}`, { installationDays: 2 });
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  pkgId = (await call("POST", "/products", { code: "WP", name: "Warmtepomp", productGroupId: groupId, type: "package", vatCode: "hoog" })).json().id;
  extraId = (await call("POST", "/products", { code: "MW-GROEP", name: "Extra groep meterkast", productGroupId: groupId, type: "extra_work", vatCode: "hoog" })).json().id;
  await call("POST", `/products/${pkgId}/sales-prices`, { scopeId: channelId, priceCents: 1_000_000, validFrom: todayIso() });
  await call("POST", `/products/${extraId}/sales-prices`, { scopeId: channelId, priceCents: 35_000, validFrom: todayIso() });
  regionId = (await call("POST", "/regions", { name: "Midden", postalRanges: [[1000, 1999]] })).json().id;
  partnerA = (await call("POST", "/organizations", { name: "Partner A", type: "installation_partner" })).json().id;
  partnerB = (await call("POST", "/organizations", { name: "Partner B", type: "installation_partner" })).json().id;
  partnerAHeaders = await partnerUser(partnerA, "partner-a");
  partnerBHeaders = await partnerUser(partnerB, "partner-b");
  // Vandaag en de komende dagen plannen toestaan (anders kan de test geen rapport indienen).
  await call("PUT", "/settings/planning.survey_lead_days", { value: 0 });
  await call("PUT", "/settings/planning.installation_lead_days", { value: 0 });
});
afterAll(async () => ctx.close());

describe("regio's", () => {
  it("postcode valt in een regio op basis van de cijfers", () => {
    expect(regionContains([[1000, 1999]], "1234AB")).toBe(true);
    expect(regionContains([[1000, 1999]], "2000AA")).toBe(false);
    expect(regionContains([[1000, 1099], [3500, 3599]], "3511 AB")).toBe(true);
  });
  it("weigert ongeldige gebieden", async () => {
    expect((await call("POST", "/regions", { name: "Fout", postalRanges: [[2000, 1000]] })).statusCode).toBe(400);
  });
});

describe("planning en partnerportaal", () => {
  it("partner geeft beschikbaarheid op; alleen voor zichzelf", async () => {
    const today = todayIso();
    const entries = [0, 1, 2, 3].map((d) => ({ regionId, date: addDays(today, d), surveySlots: 1, installationSlots: 1 }));
    expect((await call("PUT", "/partner/availability", { entries }, partnerAHeaders)).statusCode).toBe(200);
    const mine = (await call("GET", `/partner/availability?from=${today}&to=${addDays(today, 7)}`, undefined, partnerAHeaders)).json();
    expect(mine).toHaveLength(4);
    const other = (await call("GET", `/partner/availability?from=${today}&to=${addDays(today, 7)}`, undefined, partnerBHeaders)).json();
    expect(other).toHaveLength(0);
    // Partner kan niet bij interne routes
    expect((await call("GET", "/appointments", undefined, partnerAHeaders)).statusCode).toBe(403);
    expect((await call("GET", "/customers", undefined, partnerAHeaders)).statusCode).toBe(403);
  });

  it("volledige keten: schouw → aanbetaling vóór schouw → rapport met meerwerk → installatie → oplevering → eindfactuur", async () => {
    const projectId = await projectReadyForSurvey("Keten");
    const toPlan = (await call("GET", "/planning/to-plan?type=survey")).json();
    expect(toPlan.map((p: { projectId: string }) => p.projectId)).toContain(projectId);

    // Vrije momenten: alleen partner A heeft beschikbaarheid
    const slots = (await call("GET", `/planning/slots?projectId=${projectId}&type=survey`)).json();
    expect(slots.slots[0]).toMatchObject({ date: todayIso(), partnerId: partnerA });

    const appt = await call("POST", `/projects/${projectId}/appointments`, { type: "survey", date: addDays(todayIso(), 3), partnerId: partnerA, regionId, timeWindow: "morning" });
    expect(appt.statusCode, appt.body).toBe(201);
    expect(mail.sent.at(-1)!.subject).toContain("schouw is ingepland");
    // Capaciteit op die dag is nu op
    const other = await projectReadyForSurvey("Vol");
    expect((await call("POST", `/projects/${other}/appointments`, { type: "survey", date: addDays(todayIso(), 3), partnerId: partnerA, regionId })).json().error.code).toBe("no_capacity");

    // Automatisch: status → schouw ingepland → aanbetalingsfactuur met vervaldatum 2 dagen vóór de schouw
    await flush();
    expect(await statusKey(projectId)).toBe("schouw_ingepland");
    const [deposit] = (await call("GET", `/invoices?projectId=${projectId}`)).json();
    expect(deposit.type).toBe("deposit");
    expect(deposit.dueDate).toBe(addDays(todayIso(), 1));

    // Partner B ziet deze afspraak niet; partner A wel, met de te installeren regels
    expect((await call("GET", `/partner/appointments/${appt.json().id}`, undefined, partnerBHeaders)).statusCode).toBe(404);
    const detail = (await call("GET", `/partner/appointments/${appt.json().id}`, undefined, partnerAHeaders)).json();
    expect(detail.scope[0].code).toBe("WP");
    expect(JSON.stringify(detail)).not.toMatch(/unitPriceCents|priceCents/);

    // Klant betaalt de aanbetaling → automatisch "aanbetaling ontvangen"
    await call("POST", `/invoices/${deposit.id}/payments`, { amountCents: deposit.totalCents, method: "bank_transfer" });
    await flush();
    expect(await statusKey(projectId)).toBe("aanbetaling_ontvangen");

    // Rapport kan pas op de dag zelf; voor de test verzetten we de schouw naar vandaag
    expect((await call("POST", `/partner/appointments/${appt.json().id}/report`, { positive: true, data: {} }, partnerAHeaders)).json().error.code).toBe("too_early");
    await call("POST", `/appointments/${appt.json().id}/cancel`, { reason: "Verzet naar vandaag", notifyCustomer: false });
    const today = (await call("POST", `/projects/${projectId}/appointments`, { type: "survey", date: todayIso(), partnerId: partnerA, regionId })).json();

    // Foto uploaden: alleen echte afbeeldingen
    expect((await call("POST", `/partner/appointments/${today.id}/files`, { filename: "x.txt", dataBase64: Buffer.from("hallo wereld").toString("base64") }, partnerAHeaders)).json().error.code).toBe("file_type");
    const photo = await call("POST", `/partner/appointments/${today.id}/files`, { filename: "meterkast.jpg", dataBase64: JPEG }, partnerAHeaders);
    expect(photo.statusCode, photo.body).toBe(201);
    expect((await call("GET", `/files/${photo.json().id}`, undefined, partnerBHeaders)).statusCode).toBe(404);

    // Schouwrapport met meerwerk
    const rep = await call("POST", `/partner/appointments/${today.id}/report`, { positive: true, data: { remarks: "Meterkast vol", extraWork: [{ productId: extraId, quantity: 1 }] } }, partnerAHeaders);
    expect(rep.statusCode, rep.body).toBe(200);
    await flush();
    expect(await statusKey(projectId)).toBe("schouw_uitgevoerd");

    // Gecko keurt goed → meerwerk-offerte (concept) → versturen → klant accepteert
    const pending = (await call("GET", "/reports?review=pending")).json();
    const review = (await call("POST", `/reports/${pending[0].id}/review`, { approve: true })).json();
    expect(review.extraWorkQuoteId).toBeTruthy();
    const xq = (await call("GET", `/quotes/${review.extraWorkQuoteId}`)).json();
    expect(xq.kind).toBe("extra_work");
    expect(xq.totals.subtotalCents).toBe(35_000);
    await call("POST", `/quotes/${xq.id}/send`);
    await flush();
    expect(await statusKey(projectId)).toBe("meerwerk_akkoord");
    await call("POST", `/quotes/${xq.id}/accept`, { acceptedByName: "Keten", method: "email" });
    await flush();
    expect(await statusKey(projectId)).toBe("installatie_inplannen");

    // Installatie: zelfde partner verplicht, 2 dagen
    expect((await call("POST", `/projects/${projectId}/appointments`, { type: "installation", date: addDays(todayIso(), 1), partnerId: partnerB, regionId })).json().error.code).toBe("partner_mismatch");
    const inst = (await call("POST", `/projects/${projectId}/appointments`, { type: "installation", date: todayIso(), partnerId: partnerA, regionId })).json();
    expect(inst.days).toBe(2);
    await flush();
    expect(await statusKey(projectId)).toBe("installatie_ingepland");

    // Oplevering zonder handtekening: geweigerd
    expect((await call("POST", `/partner/appointments/${inst.id}/report`, { positive: true, data: { serialNumbers: ["SN1"] } }, partnerAHeaders)).json().error.code).toBe("signature_required");
    const sig = (await call("POST", `/partner/appointments/${inst.id}/files`, { filename: "handtekening.jpg", dataBase64: JPEG }, partnerAHeaders)).json();
    await call("POST", `/partner/appointments/${inst.id}/report`, { positive: true, data: { serialNumbers: ["SN1"] }, customerSignedName: "Keten", customerSignatureFileId: sig.id }, partnerAHeaders);
    await flush();
    expect(await statusKey(projectId)).toBe("oplevering_controle");

    const pending2 = (await call("GET", `/reports?review=pending&projectId=${projectId}`)).json();
    await call("POST", `/reports/${pending2[0].id}/review`, { approve: true });
    await flush();
    expect(await statusKey(projectId)).toBe("eindfactuur_open");

    // Eindfactuur: offerte + meerwerk − aanbetaling
    const invoices = (await call("GET", `/invoices?projectId=${projectId}`)).json();
    const final = invoices.find((i: { type: string }) => i.type === "final");
    const detailFinal = (await call("GET", `/invoices/${final.id}`)).json();
    expect(detailFinal.subtotalCents).toBe(1_000_000 + 35_000 - 700_000);
    expect(detailFinal.lines.some((l: { description: string }) => l.description.startsWith("Meerwerk:"))).toBe(true);
    // Eindfactuur betaald → afgerond
    await call("POST", `/invoices/${final.id}/payments`, { amountCents: detailFinal.totalCents, method: "bank_transfer" });
    await flush();
    expect(await statusKey(projectId)).toBe("afgerond");
  });

  it("afgekeurd rapport moet opnieuw worden ingediend", async () => {
    const projectId = await projectReadyForSurvey("Afkeur");
    await call("PUT", "/planning/availability", { partnerId: partnerA, entries: [{ regionId, date: todayIso(), surveySlots: 3, installationSlots: 1 }] });
    const a = (await call("POST", `/projects/${projectId}/appointments`, { type: "survey", date: todayIso(), partnerId: partnerA, regionId })).json();
    await call("POST", `/partner/appointments/${a.id}/report`, { positive: true, data: { remarks: "kort" } }, partnerAHeaders);
    const [r] = (await call("GET", `/reports?review=pending&projectId=${projectId}`)).json();
    await call("POST", `/reports/${r.id}/review`, { approve: false, note: "Foto's van de meterkast ontbreken" });
    const again = await call("POST", `/partner/appointments/${a.id}/report`, { positive: true, data: { remarks: "met foto's" } }, partnerAHeaders);
    expect(again.statusCode, again.body).toBe(200);
  });

  it("signaleert onbetaalde aanbetaling bij geplande schouw; no-show geeft €250 boete", async () => {
    const projectId = await projectReadyForSurvey("Signaal");
    await call("PUT", "/planning/availability", { partnerId: partnerB, entries: [{ regionId, date: addDays(todayIso(), 2), surveySlots: 1, installationSlots: 0 }] });
    const a = (await call("POST", `/projects/${projectId}/appointments`, { type: "survey", date: addDays(todayIso(), 2), partnerId: partnerB, regionId })).json();
    await flush();
    const listed = (await call("GET", `/appointments?projectId=${projectId}`)).json();
    expect(listed[0].depositUnpaid).toBe(true);
    const [deposit] = (await call("GET", `/invoices?projectId=${projectId}`)).json();
    await call("POST", `/invoices/${deposit.id}/payments`, { amountCents: deposit.totalCents, method: "bank_transfer" });
    expect((await call("GET", `/appointments?projectId=${projectId}`)).json()[0].depositUnpaid).toBe(false);

    await call("POST", `/appointments/${a.id}/cancel`, { reason: "Monteur kwam niet", partnerNoShow: true, notifyCustomer: false });
    const penalties = (await call("GET", `/penalties?partnerId=${partnerB}`)).json();
    expect(penalties).toHaveLength(1);
    expect(penalties[0]).toMatchObject({ amountCents: 25_000, status: "open" });
    // Partner ziet eigen sanctie, andere partner niet
    expect((await call("GET", "/partner/penalties", undefined, partnerBHeaders)).json()).toHaveLength(1);
    expect((await call("GET", "/partner/penalties", undefined, partnerAHeaders)).json()).toHaveLength(0);
    const waived = (await call("POST", `/penalties/${penalties[0].id}/waive`, { reason: "Overmacht: storing" })).json();
    expect(waived.status).toBe("waived");
  });

  it("capaciteit kan niet lager dan geplande afspraken; postcode buiten regio geeft melding", async () => {
    const res = await call("PUT", "/partner/availability", { entries: [{ regionId, date: todayIso(), surveySlots: 0, installationSlots: 0 }] }, partnerAHeaders);
    expect(res.json().error.code).toBe("capacity_in_use");
    const outside = await projectReadyForSurvey("Buiten", "9999ZZ");
    expect((await call("GET", `/planning/slots?projectId=${outside}&type=survey`)).json().message).toContain("geen enkele regio");
  });
});
