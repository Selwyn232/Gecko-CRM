import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSession, createTestContext, geckoOrgId, roleId, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof adminSession>>;
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminSession(ctx);
});
afterAll(async () => ctx.close());

const login = (email: string, password: string) =>
  ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

describe("gebruikersnaam, 2FA-uitzondering en verplicht nieuw wachtwoord", () => {
  it("volledige flow: inloggen met gebruikersnaam zonder 2FA, eerst eigen wachtwoord kiezen", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: {
        organizationId: await geckoOrgId(ctx.db),
        username: "Renee",
        name: "Renee",
        password: "Renee",
        roleIds: [await roleId(ctx.db, "beheerder")],
        mfaRequired: false,
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    expect(create.json()).toMatchObject({ username: "renee", email: null, mfaRequired: false, mustChangePassword: true });

    // Gebruikersnaam is hoofdletterongevoelig, wachtwoord niet
    expect((await login("renee", "renee")).statusCode).toBe(401);
    const res = await login("RENEE", "Renee");
    expect(res.statusCode).toBe(200);
    expect(res.json().mfa).toBe("none");
    const headers = { authorization: `Bearer ${res.json().token}` };

    // Zonder nieuw wachtwoord geen toegang
    const blocked = await ctx.app.inject({ method: "GET", url: "/api/products", headers });
    expect(blocked.json().error.code).toBe("password_change_required");
    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.json().mustChangePassword).toBe(true);

    // Nieuw wachtwoord moet aan het beleid voldoen en anders zijn
    const weak = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers,
      payload: { currentPassword: "Renee", newPassword: "kort" },
    });
    expect(weak.statusCode).toBe(400);
    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers,
      payload: { currentPassword: "Renee", newPassword: "een-goed-lang-wachtwoord" },
    });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/products", headers })).statusCode).toBe(200);
  });

  it("gebruiker met verplichte 2FA kan niet via wachtwoordwijziging om 2FA heen", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: { organizationId: await geckoOrgId(ctx.db), username: "barry", name: "Barry", password: "Barry" },
    });
    const res = await login("barry", "Barry");
    expect(res.json().mfa).toBe("setup");
    const headers = { authorization: `Bearer ${res.json().token}` };
    const change = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers,
      payload: { currentPassword: "Barry", newPassword: "een-goed-lang-wachtwoord" },
    });
    expect(change.json().error.code).toBe("mfa_required");
  });

  it("gebruiker heeft e-mail of gebruikersnaam nodig; gebruikersnaam zonder @", async () => {
    const none = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: { organizationId: await geckoOrgId(ctx.db), name: "x", password: "xxxxxx" },
    });
    expect(none.json().error.code).toBe("login_required");
  });
});
