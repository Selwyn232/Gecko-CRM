import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCutoutFetcher } from "../src/modules/photos/cutout.js";
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

  it("professionele uitsnede: Photoroom (met terugval naar alleen uitsnede) of remove.bg; zonder sleutel uit", async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const post = () => ctx.app.inject({ method: "POST", url: "/api/auth/me/photo/cutout", headers: h, payload: { dataUrl: JPEG } });
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me/photo/cutout", headers: h })).json().provider).toBeNull();
    expect((await post()).json().error.code).toBe("cutout_unavailable");

    const urls: string[] = [];
    process.env.PHOTOROOM_API_KEY = "test";
    setCutoutFetcher(async (url) => {
      urls.push(url);
      // Plan zonder studiobelichting: v2 geeft 402, daarna v1 (alleen uitsnede)
      return url.includes("/v2/") ? new Response("plan", { status: 402 }) : new Response(PNG, { status: 200 });
    });
    const r = (await post()).json();
    expect(r).toMatchObject({ provider: "photoroom", relit: false });
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(urls).toEqual(["https://image-api.photoroom.com/v2/edit", "https://sdk.photoroom.com/v1/segment"]);
    delete process.env.PHOTOROOM_API_KEY;

    process.env.REMOVEBG_API_KEY = "test";
    setCutoutFetcher(async (url) => (url.includes("remove.bg") ? new Response(PNG, { status: 200 }) : new Response("x", { status: 500 })));
    expect((await post()).json()).toMatchObject({ provider: "removebg", relit: false });
    delete process.env.REMOVEBG_API_KEY;
    setCutoutFetcher(null);
  });
});
