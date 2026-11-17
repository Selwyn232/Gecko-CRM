import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../src/modules/auth/schema.js";
import { adminSession, createTestContext, geckoOrgId, makeUser, PASSWORD, roleId, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof adminSession>>;
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminSession(ctx);
});
afterAll(async () => ctx.close());

const login = (email: string, password: string) =>
  ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const createUserApi = async (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: "POST", url: "/api/users", headers: admin.headers, payload: { organizationId: await geckoOrgId(ctx.db), ...payload } });

describe("inlognaam = e-mailadres, 2FA-uitzondering en verplicht nieuw wachtwoord", () => {
  it("volledige flow: inloggen met e-mailadres zonder 2FA, eerst eigen wachtwoord kiezen", async () => {
    const create = await createUserApi({ email: "Renee@Gecko.example", username: "renee", name: "Renee", password: "Renee", roleIds: [await roleId(ctx.db, "beheerder")], mfaRequired: false });
    expect(create.statusCode, create.body).toBe(201);
    // Een meegestuurde gebruikersnaam wordt genegeerd: de inlognaam is het e-mailadres
    expect(create.json()).toMatchObject({ username: null, email: "renee@gecko.example", mfaRequired: false, mustChangePassword: true });
    expect((await login("renee", "Renee")).statusCode).toBe(401);

    // E-mailadres is hoofdletterongevoelig, wachtwoord niet
    expect((await login("renee@gecko.example", "renee")).statusCode).toBe(401);
    const res = await login("RENEE@gecko.example", "Renee");
    expect(res.statusCode).toBe(200);
    expect(res.json().mfa).toBe("none");
    const headers = { authorization: `Bearer ${res.json().token}` };

    // Zonder nieuw wachtwoord geen toegang
    expect((await ctx.app.inject({ method: "GET", url: "/api/products", headers })).json().error.code).toBe("password_change_required");
    const weak = await ctx.app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: { currentPassword: "Renee", newPassword: "kort" } });
    expect(weak.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: { currentPassword: "Renee", newPassword: "een-goed-lang-wachtwoord" } });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/products", headers })).statusCode).toBe(200);
  });

  it("gebruiker met verplichte 2FA kan niet via wachtwoordwijziging om 2FA heen", async () => {
    await createUserApi({ email: "barry@gecko.example", name: "Barry", password: "Barry" });
    const res = await login("barry@gecko.example", "Barry");
    expect(res.json().mfa).toBe("setup");
    const headers = { authorization: `Bearer ${res.json().token}` };
    const change = await ctx.app.inject({ method: "POST", url: "/api/auth/change-password", headers, payload: { currentPassword: "Barry", newPassword: "een-goed-lang-wachtwoord" } });
    expect(change.json().error.code).toBe("mfa_required");
  });

  it("e-mailadres is verplicht", async () => {
    const none = await createUserApi({ name: "x", password: "xxxxxx", roleIds: [] });
    expect(none.statusCode).toBe(400);
    const onlyName = await createUserApi({ username: "piet", name: "x", password: "xxxxxx", roleIds: [] });
    expect(onlyName.statusCode).toBe(400);
  });

  it("oud account met alleen gebruikersnaam blijft werken tot er een e-mailadres is; daarna alleen e-mail", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    // Zoals Jurriaan in productie: alleen een gebruikersnaam
    await ctx.db.update(users).set({ email: null, username: "jurriaan", mfaRequired: false }).where(eq(users.id, u.id));
    expect((await login("jurriaan", PASSWORD)).statusCode).toBe(200);
    const list = (await ctx.app.inject({ method: "GET", url: "/api/users", headers: admin.headers })).json() as { id: string; email: string | null; username: string | null }[];
    expect(list.find((x) => x.id === u.id)).toMatchObject({ email: null, username: "jurriaan" });
    // E-mailadres leegmaken kan niet
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/users/${u.id}`, headers: admin.headers, payload: { email: "" } })).statusCode).toBe(400);
    // E-mailadres invullen: gebruikersnaam vervalt
    const upd = await ctx.app.inject({ method: "PATCH", url: `/api/users/${u.id}`, headers: admin.headers, payload: { email: "jurriaan@gecko.example" } });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json()).toMatchObject({ email: "jurriaan@gecko.example", username: null });
    expect((await login("jurriaan", PASSWORD)).statusCode).toBe(401);
    expect((await login("jurriaan@gecko.example", PASSWORD)).statusCode).toBe(200);
  });
});
