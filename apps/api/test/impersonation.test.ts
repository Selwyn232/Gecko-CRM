import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "../src/modules/audit/schema.js";
import { adminSession, createTestContext, makeUser, PASSWORD, type TestContext } from "./helpers.js";

let ctx: TestContext;
let admin: Awaited<ReturnType<typeof adminSession>>;
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminSession(ctx);
});
afterAll(async () => ctx.close());

/** Cookies uit een response als Cookie-header. */
const cookiesFrom = (res: { cookies: { name: string; value: string }[] }, base: Record<string, string> = {}) => {
  const jar = { ...base };
  for (const c of res.cookies) {
    if (c.value) jar[c.name] = c.value;
    else delete jar[c.name];
  }
  return jar;
};
const header = (jar: Record<string, string>) => ({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") });

describe("inloggen als", () => {
  it("beheerder kijkt mee als gebruiker en keert terug; alles gelogd", async () => {
    const target = await makeUser(ctx.db, ["planner"]);
    let jar: Record<string, string> = { gecko_session: admin.token };
    const start = await ctx.app.inject({ method: "POST", url: `/api/users/${target.id}/impersonate`, headers: header(jar) });
    expect(start.statusCode, start.body).toBe(200);
    jar = cookiesFrom(start, jar);
    expect(jar.gecko_admin_session).toBe(admin.token);

    const me = (await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: header(jar) })).json();
    expect(me.id).toBe(target.id);
    expect(me.impersonatedBy.id).toBe(admin.user.id);
    // De planner mag geen rollen beheren — ook niet als de beheerder meekijkt
    expect((await ctx.app.inject({ method: "POST", url: "/api/roles", headers: header(jar), payload: { key: "x_y", name: "x", permissions: [] } })).statusCode).toBe(403);

    // Wijziging tijdens meekijken: gelogd op naam van de gebruiker, met de beheerder erbij
    await ctx.app.inject({ method: "POST", url: "/api/customers", headers: header(jar), payload: { lastName: "Meekijk" } }); // planner mag dit niet
    const stop = await ctx.app.inject({ method: "POST", url: "/api/auth/stop-impersonation", headers: header(jar) });
    jar = cookiesFrom(stop, jar);
    expect(jar.gecko_session).toBe(admin.token);
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: header(jar) })).json().id).toBe(admin.user.id);

    const [started] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.impersonation_started"), eq(auditLog.entityId, target.id)));
    expect(started!.actorUserId).toBe(admin.user.id);
  });

  it("niet als jezelf, niet als andere beheerder, niet zonder recht", async () => {
    expect((await ctx.app.inject({ method: "POST", url: `/api/users/${admin.user.id}/impersonate`, headers: admin.headers })).json().error.code).toBe("impersonate_self");
    const otherAdmin = await makeUser(ctx.db, ["beheerder"]);
    expect((await ctx.app.inject({ method: "POST", url: `/api/users/${otherAdmin.id}/impersonate`, headers: admin.headers })).json().error.code).toBe("impersonate_admin");
    const u = await makeUser(ctx.db, ["medewerker"]);
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PASSWORD } });
    expect(login.json().mfa).toBe("setup");
  });
});
