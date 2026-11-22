import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  const web = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  const pkg = (await call("POST", "/products", { code: "TB", name: "Batterij", productGroupId: groupId, type: "package", vatCode: "hoog" })).json();
  await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: web, priceCents: 800_000, validFrom: todayIso() });
  await call("PUT", "/settings/test.mode", { value: true });
});
afterAll(async () => ctx.close());

describe("project annuleren", () => {
  it("afspraken vervallen, aanbetaling gecrediteerd, status geannuleerd, geen fee meer", async () => {
    const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
    // Standaard via Greenteam (test), met fee
    const s = (await call("POST", "/testing/scenario", { productGroupId: groupId, email: "a@example.nl", postalCode: "3511 AB" })).json();
    const slot = (await call("GET", `/planning/slots?projectId=${s.projectId}&type=survey`)).json().slots[2];
    await call("POST", `/projects/${s.projectId}/appointments`, { type: "survey", date: slot.date, technicianId: slot.technicianId, startMinute: slot.startMinute });
    await processOutbox(ctx.db, ctx.app.billing);
    const deposit = (await call("GET", `/invoices?projectId=${s.projectId}`)).json()[0];
    await call("POST", `/invoices/${deposit.id}/payments`, { amountCents: deposit.totalCents, method: "bank_transfer" });
    await processOutbox(ctx.db, ctx.app.billing);
    const feeBefore = (await call("GET", "/selfbilling/open")).json().find((p: { partner: { name: string } }) => p.partner.name === "Greenteam (test)");
    expect(feeBefore.items.some((i: { projectId: string }) => i.projectId === s.projectId)).toBe(true);

    const preview = (await call("GET", `/projects/${s.projectId}/cancellation`)).json();
    expect(preview).toMatchObject({ canCancel: true });
    expect(preview.appointments).toHaveLength(1);
    expect(preview.invoices.map((i: { id: string }) => i.id)).toEqual([deposit.id]);

    expect((await call("POST", `/projects/${s.projectId}/cancel`, { reason: "", creditInvoiceIds: [] })).statusCode).toBe(400);
    const res = await call("POST", `/projects/${s.projectId}/cancel`, { reason: "Klant ziet ervan af", creditInvoiceIds: [deposit.id] });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ canceledAppointments: 1, refundCents: deposit.totalCents });
    expect(r.creditNotes[0].totalCents).toBe(-deposit.totalCents);

    const project = (await call("GET", `/projects/${s.projectId}`)).json();
    expect(project.status.key).toBe("geannuleerd");
    const appts = (await call("GET", `/appointments?projectId=${s.projectId}`)).json();
    expect(appts.every((a: { status: string }) => a.status === "canceled")).toBe(true);
    // Geen fee meer voor een geannuleerd project
    const feeAfter = (await call("GET", "/selfbilling/open")).json().find((p: { partner: { name: string } }) => p.partner.name === "Greenteam (test)");
    expect(feeAfter?.items.some((i: { projectId: string }) => i.projectId === s.projectId) ?? false).toBe(false);
    // Nogmaals annuleren kan niet
    expect((await call("POST", `/projects/${s.projectId}/cancel`, { reason: "nog eens", creditInvoiceIds: [] })).json().error.code).toBe("cannot_cancel");
  });

  it("tijdlijn met notities, en zoeken op naam, postcode en nummers", async () => {
    const c = (await call("POST", "/customers", { firstName: "Jan", lastName: "Zoekmans", email: "jan@zoek.nl", phone: "06-12345678", property: { street: "Lindelaan", houseNumber: "12", postalCode: "7311 AB", city: "Apeldoorn" } })).json();
    expect((await call("POST", `/customers/${c.id}/notes`, { kind: "call", body: "Klant belde over planning" })).statusCode).toBe(201);
    const tl = (await call("GET", `/customers/${c.id}/timeline`)).json();
    expect(tl[0]).toMatchObject({ kind: "call", detail: "Klant belde over planning" });

    const find = async (q: string) => (await call("GET", `/search?q=${encodeURIComponent(q)}`)).json() as { kind: string; label: string; href: string }[];
    expect((await find("zoekm")).some((r) => r.href === `/klanten/${c.id}`)).toBe(true);
    expect((await find("7311ab")).some((r) => r.href === `/klanten/${c.id}`)).toBe(true);
    expect((await find("0612345678")).some((r) => r.href === `/klanten/${c.id}`)).toBe(true);
    expect((await find("lindelaan 12")).some((r) => r.href === `/klanten/${c.id}`)).toBe(true);
    expect((await find("P-1")).some((r) => r.kind === "Project")).toBe(true);
    expect((await find("F2026")).length).toBeGreaterThan(0);
    expect(await find("x")).toEqual([]);
  });

  it("AVG: inzage-export en anonimiseren (facturen blijven bewaard)", async () => {
    const c = (await call("POST", "/customers", { firstName: "Priva", lastName: "Cy", email: "privacy@example.nl", phone: "0612345678", property: { street: "Geheimstraat", houseNumber: "9", postalCode: "1234AB", city: "Ede" } })).json();
    await call("POST", `/customers/${c.id}/notes`, { kind: "note", body: "Gevoelige notitie" });
    const exp = await call("GET", `/customers/${c.id}/privacy-export`);
    expect(exp.statusCode).toBe(200);
    expect(exp.json().customer.email).toBe("privacy@example.nl");
    expect(exp.headers["content-disposition"]).toMatch(/inzage-/);

    expect((await call("POST", `/customers/${c.id}/anonymize`, { reason: "Verzoek klant", confirm: "nee" })).statusCode).toBe(400);
    const res = await call("POST", `/customers/${c.id}/anonymize`, { reason: "Verzoek klant", confirm: "ANONIMISEREN" });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await call("GET", `/customers/${c.id}`)).json();
    expect(after).toMatchObject({ firstName: null, lastName: "Geanonimiseerd", email: null, phone: null });
    expect(after.properties[0]).toMatchObject({ street: "[verwijderd]", postalCode: "1234" });
    expect((await call("GET", `/customers/${c.id}/timeline`)).json().some((e: { kind: string }) => e.kind === "note")).toBe(false);
  });

  it("AVG: anonimiseren kan niet met een lopend project", async () => {
    const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
    const s = (await call("POST", "/testing/scenario", { productGroupId: groupId, email: "lopend@example.nl", postalCode: "3511 AB" })).json();
    expect((await call("POST", `/customers/${s.customerId}/anonymize`, { reason: "Verzoek", confirm: "ANONIMISEREN" })).json().error.code).toBe("open_projects");
  });
});
