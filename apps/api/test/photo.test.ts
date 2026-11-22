import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

// Verplichte profielfoto (selfie in de huisstijl, op het toestel bewerkt).
let ctx: TestContext;
let h: Record<string, string>;
let me: { id: string };
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString("base64")}`;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  me = (await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: h })).json();
});
afterAll(() => ctx.close());

describe("profielfoto", () => {
  it("zonder foto meldt /auth/me dat; na opslaan is hij er, met versie, en op te halen", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: h })).json()).toMatchObject({ hasPhoto: false, photoVersion: null });
    expect((await ctx.app.inject({ method: "PUT", url: "/api/auth/me/photo", headers: h, payload: { dataUrl: "data:image/png;base64,AAAA" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "PUT", url: "/api/auth/me/photo", headers: h, payload: { dataUrl: JPEG } })).statusCode).toBe(200);
    const after = (await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: h })).json();
    expect(after.hasPhoto).toBe(true);
    expect(after.photoVersion).toMatch(/^[0-9a-f]{10}$/);
    const img = await ctx.app.inject({ method: "GET", url: `/api/users/${me.id}/photo`, headers: h });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    // Niet ingelogd: geen foto
    expect((await ctx.app.inject({ method: "GET", url: `/api/users/${me.id}/photo` })).statusCode).toBe(401);
  });
});
