import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { customers } from "../src/modules/customers/schema.js";
import { sendEmail } from "../src/modules/email/service.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { whatsappMessages } from "../src/modules/whatsapp/schema.js";
import { waIdFor } from "../src/modules/whatsapp/service.js";
import { MemoryWhatsappTransport } from "../src/modules/whatsapp/transport.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

// B83: WhatsApp via de Meta Cloud API.
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify";

let ctx: TestContext;
let h: Record<string, string>;
const wa = new MemoryWhatsappTransport();
let customerId: string;
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });
const flush = () => processOutbox(ctx.db, ctx.app.billing, 50);

function webhook(body: unknown, secret = "test-app-secret") {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return ctx.app.inject({ method: "POST", url: "/api/public/whatsapp/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, payload: raw });
}
const incoming = (id: string, text: string, from = "31612345678") => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
});

beforeAll(async () => {
  ctx = await createTestContext({ whatsappTransport: wa });
  h = (await adminSession(ctx)).headers;
  const c = (await call("POST", "/customers", { firstName: "Jan", lastName: "Jansen", email: "jan@example.nl", phone: "06-12345678" })).json();
  customerId = c.id;
});
afterAll(() => ctx.close());

describe("WhatsApp", () => {
  it("alleen mobiele nummers", () => {
    expect(waIdFor("+31612345678")).toBe("31612345678");
    expect(waIdFor("06 1234 5678")).toBe("31612345678");
    expect(waIdFor("+31301234567")).toBeNull();
    expect(waIdFor("+4915112345678")).toBe("4915112345678");
  });

  it("e-mail aan de klant gaat ook via WhatsApp: buiten 24 uur met het sjabloon", async () => {
    await sendEmail(ctx.db, null, { to: "jan@example.nl", subject: "Uw installatie is ingepland", html: "<p>x</p>", text: "Datum: 3 december", template: "appointment.scheduled.installation", customerId });
    await flush();
    const last = wa.sent.at(-1)!;
    expect(last.to).toBe("31612345678");
    expect(last.template).toMatchObject({ name: "gecko_bericht", language: "nl", bodyParams: ["Jan", "Uw installatie is ingepland"] });
    // Geen WhatsApp voor beveiligingscodes
    const before = wa.sent.length;
    await sendEmail(ctx.db, null, { to: "jan@example.nl", subject: "Code", html: "x", text: "123456", template: "quote.code", customerId });
    await flush();
    expect(wa.sent.length).toBe(before);
  });

  it("webhook: handtekening verplicht; bericht van de klant komt binnen en opent het 24-uursvenster", async () => {
    expect((await webhook(incoming("wamid.in.1", "Hallo"), "verkeerd")).statusCode).toBe(401);
    const res = await webhook(incoming("wamid.in.1", "Hoe laat komt de monteur?"));
    expect(res.statusCode, res.body).toBe(200);
    await webhook(incoming("wamid.in.1", "Hoe laat komt de monteur?")); // dubbel: genegeerd
    const conv = (await call("GET", `/customers/${customerId}/whatsapp`)).json();
    const inbound = conv.messages.filter((m: { direction: string }) => m.direction === "in");
    expect(inbound).toHaveLength(1);
    expect(conv.windowOpen).toBe(true);
    // Gesprekkenlijst: klant wacht op antwoord
    const list = (await call("GET", "/whatsapp/conversations")).json();
    expect(list[0]).toMatchObject({ customerId, unread: 1, lastDirection: "in" });
  });

  it("binnen 24 uur: vrije tekst vanuit het CRM en e-mails als volledige tekst", async () => {
    const res = await call("POST", `/customers/${customerId}/whatsapp`, { text: "Rond 9 uur!" });
    expect(res.statusCode, res.body).toBe(200);
    expect(wa.sent.at(-1)).toMatchObject({ to: "31612345678", text: "Rond 9 uur!" });
    await sendEmail(ctx.db, null, { to: "jan@example.nl", subject: "Factuur", html: "x", text: "Bedrag: € 100", template: "invoice.deposit", customerId });
    await flush();
    expect(wa.sent.at(-1)!.text).toContain("Bedrag: € 100");
    // Gelezen na antwoorden
    const list = (await call("GET", "/whatsapp/conversations")).json();
    expect(list[0].unread).toBe(0);
  });

  it("status-updates van Meta: afgeleverd en gelezen", async () => {
    const [out] = await ctx.db.select().from(whatsappMessages).where(eq(whatsappMessages.body, "Rond 9 uur!"));
    const status = (s: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id: out!.providerMessageId, status: s }] } }] }] });
    await webhook(status("delivered"));
    await webhook(status("read"));
    await webhook(status("delivered")); // terug naar een lagere status gebeurt niet
    const [after] = await ctx.db.select().from(whatsappMessages).where(eq(whatsappMessages.id, out!.id));
    expect(after!.status).toBe("read");
  });

  it("buiten 24 uur alleen een uitnodiging (sjabloon); STOP zet WhatsApp uit", async () => {
    await ctx.db.update(whatsappMessages).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) });
    expect((await call("POST", `/customers/${customerId}/whatsapp`, { text: "Hallo?" })).json().error.code).toBe("window_closed");
    expect((await call("POST", `/customers/${customerId}/whatsapp`, { invite: true })).statusCode).toBe(200);
    expect(wa.sent.at(-1)!.template?.name).toBe("gecko_contact");
    await webhook(incoming("wamid.in.stop", "STOP"));
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, customerId));
    expect(c!.whatsappEnabled).toBe(false);
    const before = wa.sent.length;
    await sendEmail(ctx.db, null, { to: "jan@example.nl", subject: "Nog iets", html: "x", text: "y", template: "project.status", customerId });
    await flush();
    expect(wa.sent.length).toBe(before);
  });

  it("aanmelden van de webhook bij Meta", async () => {
    const ok = await ctx.app.inject({ method: "GET", url: "/api/public/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const bad = await ctx.app.inject({ method: "GET", url: "/api/public/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=fout&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
  });

  it("bericht van een onbekend nummer komt binnen zonder klant", async () => {
    await webhook(incoming("wamid.in.unknown", "Ik wil een offerte", "31699999999"));
    const list = (await call("GET", "/whatsapp/conversations")).json();
    expect(list.some((c: { customerId: string | null; waId: string }) => c.customerId === null && c.waId === "31699999999")).toBe(true);
  });
});
