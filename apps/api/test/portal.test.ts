import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { addDays } from "../src/modules/planning/service.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

let scenario: { projectId: string; customerId: string; partnerId: string };
let portal: Record<string, string>;
let appointmentId: string;

async function loginAs(email: string) {
  await call("POST", "/public/portal/login", { email }, {});
  const link = mail.sent.filter((m) => m.to === email).at(-1)!.text.match(/mijn\/inloggen\/([\w-]+)/)![1]!;
  const res = await call("POST", "/public/portal/session", { token: link }, {});
  expect(res.statusCode, res.body).toBe(200);
  return { cookie: `gecko_portal=${res.cookies.find((c) => c.name === "gecko_portal")!.value}`, link };
}

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "zonnepanelen")))[0]!.id;
  const channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  const pkg = (await call("POST", "/products", { code: "ZP", name: "Zonnepanelen", productGroupId: groupId, type: "package", vatCode: "nul" })).json();
  await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: channelId, priceCents: 500_000, validFrom: todayIso() });
  await call("PUT", "/settings/test.mode", { value: true });
  await call("PUT", "/settings/quote.change_window_days", { value: 2 });
  scenario = (await call("POST", "/testing/scenario", { productGroupId: groupId, email: "Klant@Example.nl", postalCode: "3511 AB", salesChannelId: channelId })).json();
  const slots = (await call("GET", `/planning/slots?projectId=${scenario.projectId}&type=survey`)).json().slots as { date: string; part: string; partnerId: string }[];
  const slot = slots.find((s) => s.date === addDays(todayIso(), 5))!;
  appointmentId = (await call("POST", `/projects/${scenario.projectId}/appointments`, { type: "survey", date: slot.date, partnerId: slot.partnerId, part: slot.part })).json().id;
  await processOutbox(ctx.db, ctx.app.billing); // aanbetalingsfactuur
});
afterAll(async () => ctx.close());

describe("klantportaal Mijn Gecko", () => {
  it("inloggen met eenmalige link; onbekend adres krijgt geen mail maar hetzelfde antwoord", async () => {
    const before = mail.sent.length;
    const unknown = await call("POST", "/public/portal/login", { email: "onbekend@example.nl" }, {});
    expect(unknown.json()).toEqual({ ok: true });
    expect(mail.sent.length).toBe(before);

    const { cookie, link } = await loginAs("klant@example.nl");
    portal = { cookie };
    // Link is eenmalig
    expect((await call("POST", "/public/portal/session", { token: link }, {})).json().error.code).toBe("login_link_invalid");
    expect((await call("GET", "/public/portal/overview", undefined, {})).statusCode).toBe(401);
  });

  it("overzicht met status, fases, afspraken en facturen; betalen", async () => {
    const o = (await call("GET", "/public/portal/overview", undefined, portal)).json();
    expect(o.projects).toHaveLength(1);
    const p = o.projects[0];
    expect(p.phases).toContain("Schouw");
    expect(p.appointments[0]).toMatchObject({ id: appointmentId, type: "survey", canReschedule: true });
    expect(p.quotes[0]).toMatchObject({ status: "accepted", kind: "main" });
    const inv = p.invoices.find((i: { type: string }) => i.type === "deposit");
    expect(inv.outstandingCents).toBeGreaterThan(0);
    expect((await call("GET", `/public/portal/invoices/${inv.id}`, undefined, portal)).json().number).toBe(inv.number);
    const pay = (await call("POST", `/public/portal/invoices/${inv.id}/pay`, undefined, portal)).json();
    expect(pay.checkoutUrl).toMatch(/testbetaling/);
    // Geen interne gegevens
    expect(JSON.stringify(o)).not.toMatch(/unitCost|feeBasisPoints|internalNote/);
  });

  it("andere klant ziet niets van deze klant", async () => {
    const other = (await call("POST", "/customers", { lastName: "Ander", email: "ander@example.nl", property: { street: "X", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
    expect(other.id).toBeTruthy();
    const { cookie } = await loginAs("ander@example.nl");
    const o = (await call("GET", "/public/portal/overview", undefined, { cookie })).json();
    expect(o.projects).toHaveLength(0);
    const own = (await call("GET", "/public/portal/overview", undefined, portal)).json();
    const invId = own.projects[0].invoices[0].id;
    expect((await call("GET", `/public/portal/invoices/${invId}`, undefined, { cookie })).statusCode).toBe(404);
    expect((await call("GET", `/public/portal/appointments/${appointmentId}/options`, undefined, { cookie })).statusCode).toBe(404);
  });

  it("afspraak verzetten bij dezelfde installateur, buiten de termijn", async () => {
    const options = (await call("GET", `/public/portal/appointments/${appointmentId}/options`, undefined, portal)).json() as { date: string; part: string }[];
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((o) => o.date >= addDays(todayIso(), 2))).toBe(true);
    const target = options.find((o) => o.date === addDays(todayIso(), 8))!;
    const res = await call("POST", `/public/portal/appointments/${appointmentId}/reschedule`, target, portal);
    expect(res.statusCode, res.body).toBe(200);
    const o = (await call("GET", "/public/portal/overview", undefined, portal)).json();
    const planned = o.projects[0].appointments.filter((a: { status: string }) => a.status === "planned");
    expect(planned).toHaveLength(1);
    expect(planned[0].date).toBe(target.date);
    expect(mail.sent.at(-1)!.subject).toMatch(/schouw is ingepland/);
    // Binnen de termijn kan het niet meer
    await call("PUT", "/settings/quote.change_window_days", { value: 30 });
    expect((await call("GET", `/public/portal/appointments/${planned[0].id}/options`, undefined, portal)).json().error.code).toBe("too_late");
  });

  it("medewerker kan klant uitnodigen vanaf de klantkaart", async () => {
    const res = (await call("POST", `/customers/${scenario.customerId}/portal-invite`)).json();
    expect(res.sentTo).toBe("klant@example.nl");
    expect(mail.sent.at(-1)!.text).toMatch(/mijn\/inloggen\//);
  });
});
