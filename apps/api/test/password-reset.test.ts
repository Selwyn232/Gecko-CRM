import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountInvites } from "../src/modules/auth/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { createTestContext, loginWithMfa, makeUser, PASSWORD, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url: `/api${url}`, payload: payload as object, headers });
const tokenFrom = (html: string) => /wachtwoord-herstellen\/([A-Za-z0-9_-]+)/.exec(html)![1]!;

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
});
afterAll(() => ctx.close());

describe("wachtwoord vergeten", () => {
  it("stuurt een herstellink; nieuw wachtwoord werkt, oude sessies zijn afgemeld, 2FA blijft nodig", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    const r = await post("/public/password-reset", { email: u.email.toUpperCase() });
    expect(r.json()).toEqual({ ok: true });
    const sent = mail.sent.at(-1)!;
    expect(sent.to).toBe(u.email);
    expect(sent.subject).toMatch(/Wachtwoord opnieuw instellen/);
    const token = tokenFrom(sent.html);

    const info = await ctx.app.inject({ method: "GET", url: `/api/public/invites/${token}` });
    expect(info.json()).toMatchObject({ purpose: "reset", email: u.email });
    expect((await post(`/public/invites/${token}`, { password: "nieuw-en-lang-wachtwoord" })).statusCode).toBe(200);

    // Oude sessie is afgemeld
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode).toBe(401);
    // Oud wachtwoord werkt niet meer, nieuw wel; 2FA blijft nodig
    expect((await post("/auth/login", { email: u.email, password: PASSWORD })).statusCode).toBe(401);
    const login = await post("/auth/login", { email: u.email, password: "nieuw-en-lang-wachtwoord" });
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa).toBe("verify");
    // Link is eenmalig
    expect((await post(`/public/invites/${token}`, { password: "nog-een-ander-wachtwoord" })).json().error.code).toBe("invite_invalid");
  });

  it("verraadt niet of een adres bestaat, en stuurt niet vaker dan eens per 2 minuten", async () => {
    const before = mail.sent.length;
    expect((await post("/public/password-reset", { email: "bestaat-niet@example.nl" })).json()).toEqual({ ok: true });
    expect(mail.sent.length).toBe(before);
    const u = await makeUser(ctx.db, ["medewerker"]);
    await post("/public/password-reset", { email: u.email });
    await post("/public/password-reset", { email: u.email });
    expect(mail.sent.length).toBe(before + 1);
  });

  it("herstellink is 1 uur geldig", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    await post("/public/password-reset", { email: u.email });
    const token = tokenFrom(mail.sent.at(-1)!.html);
    await ctx.db.update(accountInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accountInvites.userId, u.id));
    expect((await post(`/public/invites/${token}`, { password: "nieuw-en-lang-wachtwoord" })).json().error.code).toBe("invite_invalid");
  });
});
