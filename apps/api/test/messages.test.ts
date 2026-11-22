import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { addDays, sendAppointmentReminders } from "../src/modules/planning/service.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const mail = new MemoryTransport();
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });
const to = (addr: string) => mail.sent.filter((m) => m.to === addr);

let scenario: { projectId: string; customerId: string; partnerId: string };

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "thuisbatterij")))[0]!.id;
  const channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  await call("PUT", "/settings/test.mode", { value: true });
  const pkg = (await call("POST", "/products", { code: "TB-MSG", name: "Thuisbatterij", productGroupId: groupId, type: "package", vatCode: "nul" })).json();
  await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: channelId, priceCents: 600_000, validFrom: todayIso() });
  const res = await call("POST", "/testing/scenario", { productGroupId: groupId, email: "klant@example.nl", postalCode: "3511 AB" });
  expect(res.statusCode, res.body).toBe(201);
  scenario = res.json();
});
afterAll(async () => ctx.close());

describe("klantberichten", () => {
  it("statuswissel stuurt het ingestelde bericht, één keer", async () => {
    await processOutbox(ctx.db, ctx.app.billing);
    await processOutbox(ctx.db, ctx.app.billing);
    const msgs = to("klant@example.nl").filter((m) => m.subject === "We plannen uw schouw in");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain("thuisbatterij");
    expect(msgs[0]!.text).not.toMatch(/\{[a-z_]+\}/);
  });

  it("afspraak inplannen gebruikt het sjabloon; herinnering de dag ervoor, maar één keer", async () => {
    const tomorrow = addDays(todayIso(), 1);
    const slots = (await call("GET", `/planning/slots?projectId=${scenario.projectId}&type=survey`)).json().slots as { date: string; startMinute: number; technicianId: string; partnerId: string }[];
    const slot = slots.find((s) => s.date === tomorrow)!;
    const res = await call("POST", `/projects/${scenario.projectId}/appointments`, { type: "survey", date: slot.date, technicianId: slot.technicianId, startMinute: slot.startMinute });
    expect(res.statusCode, res.body).toBe(201);
    expect(to("klant@example.nl").some((m) => m.subject.startsWith("Uw schouw is ingepland op"))).toBe(true);

    const noon = new Date(`${todayIso()}T12:00:00Z`);
    const early = new Date(`${todayIso()}T05:00:00Z`);
    expect((await sendAppointmentReminders(ctx.db, mail, early)).sent).toBe(0);
    expect((await sendAppointmentReminders(ctx.db, mail, noon)).sent).toBe(1);
    expect((await sendAppointmentReminders(ctx.db, mail, noon)).sent).toBe(0);
    expect(to("klant@example.nl").filter((m) => m.subject === "Herinnering: morgen uw schouw")).toHaveLength(1);
  });

  it("beheer: aanpassen, uitzetten, onbekend invulveld, voorvertoning en klantkaart", async () => {
    const list = (await call("GET", "/message-templates")).json();
    expect(list.fixed.map((f: { key: string }) => f.key)).toContain("appointment.reminder.survey");
    const group = list.groups.find((g: { productGroup: { name: string } }) => g.productGroup.name.toLowerCase().includes("batterij"));
    const afgerond = group.statuses.find((s: { statusKey: string }) => s.statusKey === "afgerond");
    expect(afgerond.template).toMatchObject({ isActive: true });

    const bad = await call("PUT", `/message-templates/status/${afgerond.journeyStatusId}`, { subject: "Klaar", body: "Hoi {klant}", isActive: true });
    expect(bad.json().error.code).toBe("unknown_placeholder");
    const ok = await call("PUT", "/message-templates/fixed/appointment.canceled", { subject: "Gaat niet door", body: "Beste {voornaam}", isActive: false });
    expect(ok.statusCode, ok.body).toBe(200);

    // Uitgezet bericht wordt niet verstuurd
    const appt = (await call("GET", `/appointments?projectId=${scenario.projectId}`)).json()[0];
    const before = mail.sent.length;
    const cancel = await call("POST", `/appointments/${appt.id}/cancel`, { reason: "test" });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(mail.sent.length).toBe(before);

    const preview = (await call("POST", "/message-templates/preview", { subject: "Hallo {voornaam}", body: "Uw {productgroep}" })).json();
    expect(preview.subject).toBe("Hallo Anna");
    expect(preview.text).toBe("Uw thuisbatterij");

    const emails = (await call("GET", `/customers/${scenario.customerId}/emails`)).json();
    expect(emails.some((e: { template: string }) => e.template === "project.status")).toBe(true);
    expect(emails[0].html).toBeUndefined();
  });
});
