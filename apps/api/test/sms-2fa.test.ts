import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeMobile } from "../src/modules/auth/service.js";
import { smsCodes } from "../src/modules/auth/schema.js";
import { MemorySmsTransport } from "../src/modules/auth/sms.js";
import { adminSession, createTestContext, makeUser, PASSWORD, type TestContext } from "./helpers.js";

const sms = new MemorySmsTransport();
let ctx: TestContext;
let admin: Record<string, string>;
const lastCode = () => /(\d{6})/.exec(sms.sent.at(-1)!.text)![1]!;
const inject = (method: "GET" | "POST", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });
async function login(email: string) {
  const r = await inject("POST", "/auth/login", {}, { email, password: PASSWORD });
  expect(r.statusCode, r.body).toBe(200);
  return { headers: { authorization: `Bearer ${r.json().token}` }, mfa: r.json().mfa as string };
}
/** Zelfde tijd overslaan als de wachttijd tussen twee sms'jes (30 s), zonder echt te wachten. */
const ageCodes = (userId: string) => ctx.db.update(smsCodes).set({ createdAt: new Date(Date.now() - 31_000) }).where(eq(smsCodes.userId, userId));

beforeAll(async () => {
  ctx = await createTestContext({ smsTransport: sms });
  admin = (await adminSession(ctx)).headers;
});
afterAll(() => ctx.close());

describe("mobiel nummer", () => {
  it("06, 0031 en +31 worden +316…; vaste nummers worden geweigerd", () => {
    expect(normalizeMobile("06 12 34 56 78")).toBe("+31612345678");
    expect(normalizeMobile("0031612345678")).toBe("+31612345678");
    expect(normalizeMobile("+32470123456")).toBe("+32470123456");
    expect(() => normalizeMobile("010 1234567")).toThrow();
    expect(() => normalizeMobile("+31101234567")).toThrow(/vast nummer/);
  });
});

describe("2FA via sms", () => {
  it("installatiepartner: instellen met sms, daarna inloggen met een sms-code", async () => {
    const u = await makeUser(ctx.db, ["installatiepartner"]);
    const { headers, mfa } = await login(u.email);
    expect(mfa).toBe("setup");
    const me = (await inject("GET", "/auth/me", headers)).json();
    expect(me).toMatchObject({ smsAllowed: true, mfaMethod: null });

    const setup = await inject("POST", "/auth/mfa/sms/setup", headers, { phone: "06 12345678" });
    expect(setup.statusCode, setup.body).toBe(200);
    expect(setup.json()).toMatchObject({ phone: "06 ••••• 678", expiresInMinutes: 5 });
    expect(sms.sent.at(-1)!.to).toBe("+31612345678");
    expect(sms.sent.at(-1)!.text).toMatch(/Deel deze code met niemand/);

    expect((await inject("POST", "/auth/mfa/sms/enable", headers, { code: "000000" === lastCode() ? "111111" : "000000" })).json().error.code).toBe("invalid_code");
    const enable = await inject("POST", "/auth/mfa/sms/enable", headers, { code: lastCode() });
    expect(enable.statusCode, enable.body).toBe(200);
    expect(enable.json().recoveryCodes).toHaveLength(10);
    expect((await inject("GET", "/auth/me", headers)).json()).toMatchObject({ mfaMethod: "sms", mfaVerified: true, smsPhone: "06 ••••• 678" });

    // Opnieuw inloggen: code per sms
    const second = await login(u.email);
    expect(second.mfa).toBe("verify");
    await ageCodes(u.id);
    const sent = await inject("POST", "/auth/mfa/sms/send", second.headers);
    expect(sent.json()).toMatchObject({ phone: "06 ••••• 678" });
    const code = lastCode();
    // Een TOTP-achtige foute code telt als mislukte poging
    expect((await inject("POST", "/auth/mfa/verify", second.headers, { code: code === "123456" ? "654321" : "123456" })).statusCode).toBe(400);
    expect((await inject("POST", "/auth/mfa/verify", second.headers, { code })).statusCode).toBe(200);
    expect((await inject("GET", "/auth/me", second.headers)).json().mfaVerified).toBe(true);
    // Code is eenmalig
    const third = await login(u.email);
    expect((await inject("POST", "/auth/mfa/verify", third.headers, { code })).statusCode).toBe(400);
  });

  it("medewerker zonder recht mag geen sms gebruiken", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await login(u.email);
    expect((await inject("GET", "/auth/me", headers)).json().smsAllowed).toBe(false);
    const r = await inject("POST", "/auth/mfa/sms/setup", headers, { phone: "0612345678" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("sms_not_allowed");
  });

  it("limieten: wachttijd tussen codes, en na 5 foute pogingen is de code ongeldig", async () => {
    const u = await makeUser(ctx.db, ["installatiepartner"]);
    const { headers } = await login(u.email);
    await inject("POST", "/auth/mfa/sms/setup", headers, { phone: "0687654321" });
    const tooSoon = await inject("POST", "/auth/mfa/sms/setup", headers, { phone: "0687654321" });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error.code).toBe("sms_too_soon");
    const code = lastCode();
    const wrong = code === "999999" ? "888888" : "999999";
    for (let i = 0; i < 5; i++) await inject("POST", "/auth/mfa/sms/enable", headers, { code: wrong });
    expect((await inject("POST", "/auth/mfa/sms/enable", headers, { code })).json().error.code).toBe("invalid_code");
  });

  it("mislukte verzending geeft een duidelijke fout en geen bruikbare code", async () => {
    const u = await makeUser(ctx.db, ["installatiepartner"]);
    const { headers } = await login(u.email);
    sms.fail = true;
    const r = await inject("POST", "/auth/mfa/sms/setup", headers, { phone: "0611111111" });
    sms.fail = false;
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe("sms_failed");
  });

  it("beheerder reset 2FA: ook de sms-instelling verdwijnt", async () => {
    const u = await makeUser(ctx.db, ["installatiepartner"]);
    const { headers } = await login(u.email);
    await inject("POST", "/auth/mfa/sms/setup", headers, { phone: "0622222222" });
    await inject("POST", "/auth/mfa/sms/enable", headers, { code: lastCode() });
    expect((await inject("GET", "/users", admin)).json().find((x: { id: string }) => x.id === u.id).mfaMethod).toBe("sms");
    expect((await inject("POST", `/users/${u.id}/reset-mfa`, admin)).statusCode).toBe(200);
    const again = await login(u.email);
    expect(again.mfa).toBe("setup");
  });

  it("zonder sms-dienst (geen CM.com-sleutel) is sms niet beschikbaar", async () => {
    const plain = await createTestContext({ smsTransport: null });
    try {
      const u = await makeUser(plain.db, ["installatiepartner"]);
      const r = await plain.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: u.email, password: PASSWORD } });
      const headers = { authorization: `Bearer ${r.json().token}` };
      expect((await plain.app.inject({ method: "GET", url: "/api/auth/me", headers })).json().smsAllowed).toBe(false);
      expect((await plain.app.inject({ method: "POST", url: "/api/auth/mfa/sms/setup", headers, payload: { phone: "0612345678" } })).json().error.code).toBe("sms_unavailable");
    } finally {
      await plain.close();
    }
  });
});

describe("CM.com-koppeling", () => {
  it("stuurt het bericht in het formaat van CM.com (00-nummer, afzender, product token)", async () => {
    const { CmSmsTransport } = await import("../src/modules/auth/sms.js");
    const calls: { url: string; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await new CmSmsTransport("token-123", "Gecko", fake).send("+31612345678", "Code 123456", "ref-1");
    expect(calls[0]!.url).toBe("https://gw.cmtelecom.com/v1.0/message");
    expect(calls[0]!.body).toEqual({
      messages: { authentication: { producttoken: "token-123" }, msg: [{ from: "Gecko", to: [{ number: "0031612345678" }], body: { type: "auto", content: "Code 123456" }, reference: "ref-1" }] },
    });
    const failing = (async () => new Response("bad token", { status: 401 })) as unknown as typeof fetch;
    await expect(new CmSmsTransport("x", "Gecko", failing).send("+31612345678", "x")).rejects.toThrow(/CM.com 401/);
  });
});
