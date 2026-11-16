import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSession, createTestContext, loginWithMfa, makeUser, roleId, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: { headers: Record<string, string>; user: { id: string } };
const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminSession(ctx);
});
afterAll(async () => ctx.close());

describe("geen escalatie van rechten", () => {
  it("gebruikersbeheerder kan zichzelf geen beheerder maken of een beheerder overnemen", async () => {
    const role = (await call("POST", "/roles", admin.headers, { key: "gebruikersbeheer", name: "Gebruikersbeheer", permissions: ["users.read", "users.manage"] })).json();
    const u = await makeUser(ctx.db, ["gebruikersbeheer"]);
    const h = (await loginWithMfa(ctx.app, u.email)).headers;
    const adminRole = await roleId(ctx.db, "beheerder");

    const self = await call("PATCH", `/users/${u.id}`, h, { roleIds: [role.id, adminRole] });
    expect(self.json().error.code).toBe("privilege_escalation");
    const created = await call("POST", "/users", h, { organizationId: u.organizationId, email: "nieuw@example.nl", name: "Nieuw", password: "een-lang-wachtwoord-123", roleIds: [adminRole] });
    expect(created.json().error.code).toBe("privilege_escalation");
    expect((await call("POST", `/users/${admin.user.id}/reset-password`, h, { password: "een-lang-wachtwoord-123" })).json().error.code).toBe("privilege_escalation");
    expect((await call("POST", `/users/${admin.user.id}/reset-mfa`, h)).json().error.code).toBe("privilege_escalation");
    // Wel toegestaan: rollen die binnen de eigen rechten vallen
    const ok = await call("POST", "/users", h, { organizationId: u.organizationId, email: "collega@example.nl", name: "Collega", password: "een-lang-wachtwoord-123", roleIds: [role.id] });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("inloggen als een gebruikersbeheerder kan niet; tijdens inloggen-als geen 2FA instellen", async () => {
    const u = await makeUser(ctx.db, ["gebruikersbeheer"]);
    expect((await call("POST", `/users/${u.id}/impersonate`, admin.headers)).json().error.code).toBe("impersonate_admin");
    const plain = await makeUser(ctx.db, ["medewerker"]);
    const imp = await call("POST", `/users/${plain.id}/impersonate`, admin.headers);
    const cookie = { cookie: `gecko_session=${imp.cookies.find((c) => c.name === "gecko_session")!.value}` };
    expect((await call("POST", "/auth/mfa/setup", cookie)).json().error.code).toBe("impersonation_not_allowed");
  });
});
