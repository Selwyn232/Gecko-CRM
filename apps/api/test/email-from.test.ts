import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { customers } from "../src/modules/customers/schema.js";
import { sendEmail } from "../src/modules/email/service.js";
import { withFromName, type EmailMessage, type EmailTransport } from "../src/modules/email/transport.js";
import { adminSession, createTestContext, makeUser, type TestContext } from "./helpers.js";

describe("afzendernaam", () => {
  it("vervangt de naam, houdt het adres", () => {
    expect(withFromName("Gecko <klantenservice@gecko.nl>", "Ingrid | Gecko")).toBe('"Ingrid | Gecko" <klantenservice@gecko.nl>');
    expect(withFromName("klantenservice@gecko.nl", 'Rare "naam" <x>')).toBe('"Rare naam x" <klantenservice@gecko.nl>');
    expect(withFromName("Gecko <klantenservice@gecko.nl>", null)).toBe("Gecko <klantenservice@gecko.nl>");
  });
});

describe("mail aan een klant komt van zijn klantspecialist (B84)", () => {
  let ctx: TestContext;
  const sent: EmailMessage[] = [];
  const transport: EmailTransport = { name: "memory", send: async (m) => (sent.push(m), { providerMessageId: `m${sent.length}` }) };
  beforeAll(async () => {
    ctx = await createTestContext({ emailTransport: transport });
  });
  afterAll(() => ctx.close());

  it("voornaam van de specialist; zonder specialist de standaardafzender", async () => {
    const h = (await adminSession(ctx)).headers;
    const c = (await ctx.app.inject({ method: "POST", url: "/api/customers", headers: h, payload: { lastName: "Klant", email: "k@example.nl" } })).json();
    await sendEmail(ctx.db, transport, { to: "k@example.nl", subject: "x", html: "x", text: "x", template: "project.status", customerId: c.id });
    expect(sent.at(-1)!.fromName).toBeNull();
    const s = await makeUser(ctx.db, ["klantspecialist"]);
    const { users } = await import("../src/modules/auth/schema.js");
    await ctx.db.update(users).set({ name: "Ingrid de Wit" }).where(eq(users.id, s.id));
    await ctx.db.update(customers).set({ specialistUserId: s.id }).where(eq(customers.id, c.id));
    await sendEmail(ctx.db, transport, { to: "k@example.nl", subject: "x", html: "x", text: "x", template: "project.status", customerId: c.id });
    expect(sent.at(-1)!.fromName).toBe("Ingrid | Gecko");
  });
});
