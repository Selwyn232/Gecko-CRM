import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { outboundEmails } from "../src/modules/email/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { quotes } from "../src/modules/quotes/schema.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
let groupId: string;
let channelId: string;
let pkgId: string;
let customer: { id: string; properties: { id: string }[] };

const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });
const pub = (method: "GET" | "POST", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/public${url}`, payload: payload as object, headers: { "user-agent": "TestBrowser/1.0" } });

const lastCode = () => /(\d{6})/.exec(mail.sent.at(-1)!.subject)![1]!;
const tokenFromUrl = (url: string) => url.split("/akkoord/")[1]!;

async function sentQuote() {
  const q = (await api("POST", "/quotes", { customerId: customer.id, propertyId: customer.properties[0]!.id, productGroupId: groupId, salesChannelId: channelId })).json();
  await api("POST", `/quotes/${q.id}/lines`, { productId: pkgId, quantity: 1 });
  await api("POST", `/quotes/${q.id}/send`);
  return q.id as string;
}

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "zonnepanelen")))[0]!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  pkgId = (await api("POST", "/products", { code: "ZP-10", name: "10 zonnepanelen", productGroupId: groupId, type: "package", vatCode: "nul" })).json().id;
  await api("POST", `/products/${pkgId}/sales-prices`, { scopeId: channelId, priceCents: 450000, validFrom: todayIso() });
  customer = (await api("POST", "/customers", {
    firstName: "Klaas",
    lastName: "Klant",
    email: "klaas@example.nl",
    property: { street: "Weg", houseNumber: "2", postalCode: "2345BC", city: "Gouda" },
  })).json();
});
afterAll(async () => ctx.close());

describe("offerte accepteren via e-maillink", () => {
  it("volledige flow: link → code → akkoord → project, bewijs en bevestiging", async () => {
    const quoteId = await sentQuote();
    const send = await api("POST", `/quotes/${quoteId}/send-link`, {});
    expect(send.statusCode, send.body).toBe(200);
    expect(send.json().emailStatus).toBe("sent");
    const linkMail = mail.sent.at(-1)!;
    expect(linkMail.to).toBe("klaas@example.nl");
    const token = tokenFromUrl(/http\S+\/akkoord\/[\w-]+/.exec(linkMail.text)![0]);

    const view = (await pub("GET", `/quotes/${token}`)).json();
    expect(view.canAccept).toBe(true);
    expect(view.email).toBe("k••••@example.nl");
    expect(view.quote.totals.totalCents).toBe(450000); // 0% btw
    expect(JSON.stringify(view)).not.toMatch(/unitCostCents|internalNote|margin/);

    // Zonder of met verkeerde code geen akkoord
    expect((await pub("POST", `/quotes/${token}/accept`, { code: "000000", name: "Klaas Klant", agreeTerms: true })).json().error.code).toBe("code_expired");
    await pub("POST", `/quotes/${token}/code`);
    const wrong = (await pub("POST", `/quotes/${token}/accept`, { code: lastCode() === "111111" ? "222222" : "111111", name: "Klaas Klant", agreeTerms: true })).json();
    expect(wrong.error.code).toBe("invalid_code");
    expect((await pub("POST", `/quotes/${token}/accept`, { code: lastCode(), name: "Klaas Klant", agreeTerms: false })).json().error.code).toBe("terms_required");

    const ok = await pub("POST", `/quotes/${token}/accept`, { code: lastCode(), name: "Klaas Klant", agreeTerms: true });
    expect(ok.statusCode, ok.body).toBe(200);

    const q = (await api("GET", `/quotes/${quoteId}`)).json();
    expect(q.status).toBe("accepted");
    expect(q.acceptanceMethod).toBe("signed_digital");
    expect(q.projectId).toBeTruthy();
    const [row] = await ctx.db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.acceptanceEvidence).toMatchObject({ email: "klaas@example.nl", codeVerified: true, userAgent: "TestBrowser/1.0", contentHash: row!.contentHash });

    expect(mail.sent.at(-1)!.subject).toContain("Bevestiging");
    expect(mail.sent.at(-1)!.text).toContain("14 dagen");
    // Link is na gebruik ongeldig
    expect((await pub("GET", `/quotes/${token}`)).statusCode).toBe(404);
  });

  it("een nieuwe link maakt de vorige ongeldig", async () => {
    const quoteId = await sentQuote();
    await api("POST", `/quotes/${quoteId}/send-link`, {});
    const first = tokenFromUrl(/http\S+\/akkoord\/[\w-]+/.exec(mail.sent.at(-1)!.text)![0]);
    await api("POST", `/quotes/${quoteId}/send-link`, {});
    expect((await pub("GET", `/quotes/${first}`)).statusCode).toBe(404);
  });

  it("concept-offerte kan niet ter akkoord worden verstuurd", async () => {
    const q = (await api("POST", "/quotes", { customerId: customer.id, propertyId: customer.properties[0]!.id, productGroupId: groupId, salesChannelId: channelId })).json();
    expect((await api("POST", `/quotes/${q.id}/send-link`, {})).json().error.code).toBe("quote_not_sent");
  });

  it("code geblokkeerd na 5 foute pogingen", async () => {
    const quoteId = await sentQuote();
    await api("POST", `/quotes/${quoteId}/send-link`, {});
    const token = tokenFromUrl(/http\S+\/akkoord\/[\w-]+/.exec(mail.sent.at(-1)!.text)![0]);
    await pub("POST", `/quotes/${token}/code`);
    const good = lastCode();
    const bad = good === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await pub("POST", `/quotes/${token}/accept`, { code: bad, name: "Klaas", agreeTerms: true });
    const locked = await pub("POST", `/quotes/${token}/accept`, { code: good, name: "Klaas", agreeTerms: true });
    expect(locked.json().error?.code, locked.body).toBe("code_locked");
  });

  it("legt alle e-mails vast, ook zonder e-mailkoppeling", async () => {
    const rows = await ctx.db.select().from(outboundEmails).where(eq(outboundEmails.customerId, customer.id));
    expect(rows.length).toBeGreaterThan(3);
    expect(new Set(rows.map((r) => r.template))).toEqual(new Set(["quote.link", "quote.code", "quote.accepted"]));
  });
});
