import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, PASSWORD, type TestContext } from "./helpers.js";

// ---------------------------------------------------------------- Nagebootst toestel (zoals Face ID op een iPhone)

/** Minimale CBOR-encoder (alleen wat WebAuthn nodig heeft). */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: onbekend type");
}
const b64u = (b: Buffer) => b.toString("base64url");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

class VirtualAuthenticator {
  readonly credId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly pub: KeyObject;
  private count = 0;
  userHandle = "";
  constructor(private readonly rpId: string, private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    this.pub = publicKey;
  }
  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  private authData(flags: number, attested?: Buffer) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(++this.count);
    return Buffer.concat([sha(this.rpId), Buffer.from([flags]), c, ...(attested ? [attested] : [])]);
  }
  create(options: { challenge: string; user: { id: string } }, origin?: string) {
    this.userHandle = options.user.id;
    const jwk = this.pub.export({ format: "jwk" });
    const coseKey = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const len = Buffer.from([this.credId.length >> 8, this.credId.length & 255]);
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), len, this.credId, coseKey]));
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: "public-key",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, origin)), attestationObject: b64u(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }
  get(options: { challenge: string }, opts: { userVerified?: boolean } = {}) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const authData = this.authData(opts.userVerified === false ? 0x01 : 0x05);
    const signature = sign("sha256", Buffer.concat([authData, sha(clientDataJSON)]), this.key);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
    };
  }
}

// ---------------------------------------------------------------- Tests

let ctx: TestContext;
let rpId: string;
let origin: string;
const inject = (method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });
async function passwordLogin(email: string) {
  const r = await inject("POST", "/auth/login", {}, { email, password: PASSWORD });
  return { headers: { authorization: `Bearer ${r.json().token}` }, mfa: r.json().mfa as string };
}
async function addPasskey(headers: Record<string, string>, device: VirtualAuthenticator, name = "iPhone") {
  const opt = (await inject("POST", "/auth/passkeys/register/options", headers)).json();
  return inject("POST", "/auth/passkeys/register", headers, { challengeId: opt.challengeId, name, response: device.create(opt.options) });
}

beforeAll(async () => {
  ctx = await createTestContext();
  const url = new URL(loadConfig().APP_BASE_URL);
  rpId = url.hostname;
  origin = url.origin;
});
afterAll(() => ctx.close());

describe("passkeys (Face ID e.d.)", () => {
  it("nieuwe gebruiker kiest passkey als 2FA: herstelcodes, daarna inloggen zonder wachtwoord", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers, mfa } = await passwordLogin(u.email);
    expect(mfa).toBe("setup");
    const device = new VirtualAuthenticator(rpId, origin);
    const reg = await addPasskey(headers, device, "iPhone van Test");
    expect(reg.statusCode, reg.body).toBe(200);
    expect(reg.json().recoveryCodes).toHaveLength(10);
    const me = (await inject("GET", "/auth/me", headers)).json();
    expect(me).toMatchObject({ mfaVerified: true, mfaMethod: "passkey", hasPasskey: true, passkeyDomain: rpId });

    // Inloggen met alleen de passkey
    const opt = (await inject("POST", "/auth/passkeys/login/options")).json();
    const login = await inject("POST", "/auth/passkeys/login", {}, { challengeId: opt.challengeId, response: device.get(opt.options) });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.headers["set-cookie"]).toBeTruthy();
    const me2 = (await inject("GET", "/auth/me", { authorization: `Bearer ${login.json().token}` })).json();
    expect(me2).toMatchObject({ id: u.id, mfaVerified: true });

    // Dezelfde uitdaging nog eens gebruiken kan niet
    const replay = await inject("POST", "/auth/passkeys/login", {}, { challengeId: opt.challengeId, response: device.get(opt.options) });
    expect(replay.json().error.code).toBe("passkey_expired");

    // Wachtwoord + passkey als 2FA-stap
    const pw = await passwordLogin(u.email);
    expect(pw.mfa).toBe("verify");
    const vopt = (await inject("POST", "/auth/passkeys/verify/options", pw.headers)).json();
    expect(vopt.options.allowCredentials).toHaveLength(1);
    expect((await inject("POST", "/auth/passkeys/verify", pw.headers, { challengeId: vopt.challengeId, response: device.get(vopt.options) })).statusCode).toBe(200);
    expect((await inject("GET", "/auth/me", pw.headers)).json().mfaVerified).toBe(true);
  });

  it("zonder Face ID/vingerafdruk (geen gebruikersverificatie) wordt de passkey geweigerd", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await passwordLogin(u.email);
    const device = new VirtualAuthenticator(rpId, origin);
    await addPasskey(headers, device);
    const opt = (await inject("POST", "/auth/passkeys/login/options")).json();
    const r = await inject("POST", "/auth/passkeys/login", {}, { challengeId: opt.challengeId, response: device.get(opt.options, { userVerified: false }) });
    expect(r.json().error.code).toBe("passkey_invalid");
  });

  it("passkey van een ander domein wordt geweigerd", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await passwordLogin(u.email);
    const opt = (await inject("POST", "/auth/passkeys/register/options", headers)).json();
    const fake = new VirtualAuthenticator("phishing.example", "https://phishing.example");
    const r = await inject("POST", "/auth/passkeys/register", headers, { challengeId: opt.challengeId, name: "x", response: fake.create(opt.options) });
    expect(r.json().error.code).toBe("passkey_invalid");
  });

  it("bestaande gebruiker met app-2FA voegt passkey toe (geen nieuwe herstelcodes), beheert en verwijdert", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await loginWithMfa(ctx.app, u.email);
    const device = new VirtualAuthenticator(rpId, origin);
    const reg = await addPasskey(headers, device, "MacBook");
    expect(reg.json().recoveryCodes).toBeNull();
    const list = (await inject("GET", "/auth/passkeys", headers)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "MacBook" });
    // Halverwege ingelogd (alleen wachtwoord) mag je geen passkey toevoegen
    const half = await passwordLogin(u.email);
    expect((await inject("POST", "/auth/passkeys/register/options", half.headers)).statusCode).toBe(403);
    // Verwijderen
    expect((await inject("DELETE", `/auth/passkeys/${list[0].id}`, headers)).statusCode).toBe(200);
    expect((await inject("GET", "/auth/passkeys", headers)).json()).toHaveLength(0);
    // Verwijderde passkey werkt niet meer
    const opt = (await inject("POST", "/auth/passkeys/login/options")).json();
    expect((await inject("POST", "/auth/passkeys/login", {}, { challengeId: opt.challengeId, response: device.get(opt.options) })).json().error.code).toBe("passkey_unknown");
  });

  it("beheerder reset 2FA: passkeys worden gewist", async () => {
    const admin = (await adminSession(ctx)).headers;
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await passwordLogin(u.email);
    await addPasskey(headers, new VirtualAuthenticator(rpId, origin));
    expect((await inject("POST", `/users/${u.id}/reset-mfa`, admin)).statusCode).toBe(200);
    expect((await passwordLogin(u.email)).mfa).toBe("setup");
  });

  it("geblokkeerd of inactief account kan niet inloggen met een passkey", async () => {
    const u = await makeUser(ctx.db, ["medewerker"]);
    const { headers } = await passwordLogin(u.email);
    const device = new VirtualAuthenticator(rpId, origin);
    await addPasskey(headers, device);
    const { users } = await import("../src/modules/auth/schema.js");
    const { eq } = await import("drizzle-orm");
    await ctx.db.update(users).set({ isActive: false }).where(eq(users.id, u.id));
    const opt = (await inject("POST", "/auth/passkeys/login/options")).json();
    expect((await inject("POST", "/auth/passkeys/login", {}, { challengeId: opt.challengeId, response: device.get(opt.options) })).statusCode).toBe(401);
  });
});
