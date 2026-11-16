import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentStep, totpAt } from "../src/lib/totp.js";
import { auditLog } from "../src/modules/audit/schema.js";
import { users } from "../src/modules/auth/schema.js";
import { createTestContext, loginWithMfa, makeUser, PASSWORD, type TestContext } from "./helpers.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

const login = (email: string, password = PASSWORD) =>
  ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

describe("inloggen en 2FA", () => {
  it("weigert verzoeken zonder sessie", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
  });

  it("health is openbaar", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("weigert een onjuist wachtwoord en onbekend e-mailadres met dezelfde melding", async () => {
    const u = await makeUser(ctx.db);
    const wrong = await login(u.email, "verkeerd-wachtwoord");
    const unknown = await login("bestaat-niet@gecko.test");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
  });

  it("vereist 2FA-instelling vóór toegang tot de rest van het systeem", async () => {
    const u = await makeUser(ctx.db, ["beheerder"]);
    const res = await login(u.email.toUpperCase()); // e-mail is hoofdletterongevoelig
    expect(res.statusCode).toBe(200);
    expect(res.json().mfa).toBe("setup");
    const headers = { authorization: `Bearer ${res.json().token}` };

    const blocked = await ctx.app.inject({ method: "GET", url: "/api/users", headers });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("mfa_required");

    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.json()).toMatchObject({ mfaEnabled: false, mfaVerified: false, permissions: [] });
  });

  it("volledige flow: instellen, opnieuw inloggen met code, code niet herbruikbaar", async () => {
    const u = await makeUser(ctx.db, ["beheerder"]);
    const first = await loginWithMfa(ctx.app, u.email);
    expect(first.recoveryCodes).toHaveLength(10);

    const ok = await ctx.app.inject({ method: "GET", url: "/api/users", headers: first.headers });
    expect(ok.statusCode).toBe(200);

    // Nieuwe login vraagt om verificatie
    const second = await login(u.email);
    expect(second.json().mfa).toBe("verify");
    const headers = { authorization: `Bearer ${second.json().token}` };

    // Dezelfde code als bij het instellen werkt niet nogmaals (replay)
    const step = currentStep();
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      headers,
      payload: { code: totpAt(first.secret, step - 1) },
    });
    expect(replay.statusCode).toBe(400);

    // Herstelcode werkt, maar maar één keer
    const rc = first.recoveryCodes[0]!;
    const viaRecovery = await ctx.app.inject({ method: "POST", url: "/api/auth/mfa/verify", headers, payload: { recoveryCode: rc } });
    expect(viaRecovery.statusCode).toBe(200);
    const third = await login(u.email);
    const again = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      headers: { authorization: `Bearer ${third.json().token}` },
      payload: { recoveryCode: rc },
    });
    expect(again.statusCode).toBe(400);
  });

  it("blokkeert account na 5 mislukte pogingen", async () => {
    const u = await makeUser(ctx.db);
    for (let i = 0; i < 5; i++) await login(u.email, "fout-fout-fout");
    const res = await login(u.email);
    expect(res.statusCode).toBe(423);
    const locked = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, u.id), eq(auditLog.action, "auth.account_locked")));
    expect(locked).toHaveLength(1);
  });

  it("uitloggen trekt de sessie in", async () => {
    const u = await makeUser(ctx.db, ["beheerder"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    await ctx.app.inject({ method: "POST", url: "/api/auth/logout", headers });
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(res.statusCode).toBe(401);
  });

  it("gedeactiveerde gebruiker verliest direct toegang", async () => {
    const u = await makeUser(ctx.db, ["klantspecialist"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    await ctx.db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    const res = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(res.statusCode).toBe(401);
  });

  it("wachtwoord wijzigen beëindigt andere sessies", async () => {
    const u = await makeUser(ctx.db, ["klantspecialist"]);
    const a = await loginWithMfa(ctx.app, u.email);
    const other = await login(u.email);
    const otherHeaders = { authorization: `Bearer ${other.json().token}` };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: a.headers,
      payload: { currentPassword: PASSWORD, newPassword: "nog-een-lang-wachtwoord" },
    });
    expect(res.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: otherHeaders })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: a.headers })).statusCode).toBe(200);
  });

  it("slaat het 2FA-geheim versleuteld op", async () => {
    const u = await makeUser(ctx.db, ["klantspecialist"]);
    const { secret } = await loginWithMfa(ctx.app, u.email);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, u.id));
    expect(row!.totpSecretEncrypted).not.toContain(secret);
  });
});
