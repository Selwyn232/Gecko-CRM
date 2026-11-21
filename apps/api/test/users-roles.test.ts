import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "../src/modules/audit/schema.js";
import { adminSession, createTestContext, geckoOrgId, loginWithMfa, makeUser, PASSWORD, roleId, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof adminSession>>;
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminSession(ctx);
});
afterAll(async () => ctx.close());

describe("gebruikers en rollen", () => {
  it("beheerder maakt een gebruiker aan; hash en geheimen lekken niet", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: {
        organizationId: await geckoOrgId(ctx.db),
        email: "Nieuwe@Gecko.test",
        name: "Nieuwe Collega",
        password: PASSWORD,
        roleIds: [await roleId(ctx.db, "planner")],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe("nieuwe@gecko.test");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(JSON.stringify(body)).not.toContain("totp");

    const dup = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: { organizationId: await geckoOrgId(ctx.db), email: "nieuwe@gecko.test", name: "x", password: PASSWORD },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toContain("e-mailadres");
  });

  it("weigert zwakke wachtwoorden", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: { organizationId: await geckoOrgId(ctx.db), email: "zwak@gecko.test", name: "x", password: "kort", mustChangePassword: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("weak_password");
    // Ook een startwachtwoord heeft een ondergrens
    const tooShort = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers: admin.headers,
      payload: { organizationId: await geckoOrgId(ctx.db), email: "zwak2@gecko.test", name: "x", password: "abc" },
    });
    expect(tooShort.json().error.code).toBe("weak_password");
  });

  it("gebruiker zonder recht krijgt 403", async () => {
    const u = await makeUser(ctx.db, ["planner"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    const res = await ctx.app.inject({ method: "POST", url: "/api/roles", headers, payload: { key: "x", name: "x", permissions: [] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("missing_permission");
  });

  it("nieuwe rol met rechten geeft gebruikers direct die rechten", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/roles",
      headers: admin.headers,
      payload: { key: "auditor", name: "Auditor", permissions: ["audit.read"] },
    });
    expect(create.statusCode).toBe(201);
    const role = create.json();

    const u = await makeUser(ctx.db);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    expect((await ctx.app.inject({ method: "GET", url: "/api/audit-log", headers })).statusCode).toBe(403);

    await ctx.app.inject({ method: "PATCH", url: `/api/users/${u.id}`, headers: admin.headers, payload: { roleIds: [role.id] } });
    expect((await ctx.app.inject({ method: "GET", url: "/api/audit-log", headers })).statusCode).toBe(200);
  });

  it("weigert onbekende rechten", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/roles",
      headers: admin.headers,
      payload: { key: "fout", name: "Fout", permissions: ["bestaat.niet"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("beheerdersrol is niet te wijzigen of te verwijderen", async () => {
    const adminRoleId = await roleId(ctx.db, "beheerder");
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/roles/${adminRoleId}`,
      headers: admin.headers,
      payload: { permissions: [] },
    });
    expect(patch.statusCode).toBe(400);
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/roles/${adminRoleId}`, headers: admin.headers });
    expect(del.statusCode).toBe(400);
  });

  it("rol in gebruik kan niet worden verwijderd", async () => {
    const res = await ctx.app.inject({ method: "DELETE", url: `/api/roles/${await roleId(ctx.db, "planner")}`, headers: admin.headers });
    expect(res.statusCode).toBe(409);
  });

  it("laatste actieve beheerder kan zichzelf niet buitensluiten", async () => {
    // Alle andere beheerders deactiveren zodat alleen `admin` overblijft
    await ctx.db.execute(sql`
      update users set is_active = false
      where id <> ${admin.user.id}
        and id in (select user_id from user_roles ur join roles r on r.id = ur.role_id where r.key = 'beheerder')`);
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/api/users/${admin.user.id}`,
      headers: admin.headers,
      payload: { roleIds: [] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("last_admin");
  });

  it("reset van 2FA dwingt opnieuw instellen af", async () => {
    const u = await makeUser(ctx.db, ["planner"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    const reset = await ctx.app.inject({ method: "POST", url: `/api/users/${u.id}/reset-mfa`, headers: admin.headers });
    expect(reset.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode).toBe(401);
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PASSWORD } });
    expect(login.json().mfa).toBe("setup");
  });
});

describe("audit log", () => {
  it("legt wijzigingen vast met oud en nieuw, zonder geheimen", async () => {
    const u = await makeUser(ctx.db);
    await ctx.app.inject({ method: "PATCH", url: `/api/users/${u.id}`, headers: admin.headers, payload: { name: "Andere Naam" } });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/audit-log?entityType=user&entityId=${u.id}`,
      headers: admin.headers,
    });
    const entry = res.json().items.find((i: { action: string }) => i.action === "user.updated");
    expect(entry.actorUserId).toBe(admin.user.id);
    expect(entry.changes.name).toEqual({ from: "Test Gebruiker", to: "Andere Naam" });
  });

  it("is onveranderbaar op databaseniveau", async () => {
    await expect(ctx.db.execute(sql`delete from audit_log`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`update audit_log set action = 'x'`)).rejects.toThrow();
    const [row] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, "x"))).limit(1);
    expect(row).toBeUndefined();
  });
});
