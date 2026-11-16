import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

const KEY = "test-signing-key";
process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });

function mailgunForm(fields: Record<string, string>, valid = true) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = randomBytes(16).toString("hex");
  const signature = valid ? createHmac("sha256", KEY).update(timestamp + token).digest("hex") : "0".repeat(64);
  return new URLSearchParams({ ...fields, timestamp, token, signature }).toString();
}
const post = (body: string) => ctx.app.inject({ method: "POST", url: "/api/public/inbound/mailgun", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: body });

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
});
afterAll(async () => {
  delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  await ctx.close();
});

describe("inbox", () => {
  it("weigert zonder geldige handtekening", async () => {
    expect((await post(mailgunForm({ from: "x@example.nl", subject: "hoi", "body-plain": "test" }, false))).statusCode).toBe(403);
  });

  it("ontvangt, koppelt aan klant, meldt, antwoord gaat naar klant en wordt afgehandeld", async () => {
    const c = (await call("POST", "/customers", { lastName: "Inbox", email: "Klant@Example.nl", property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
    const body = mailgunForm({ from: "Kees Inbox <klant@example.nl>", recipient: "service@mail.gecko.nl", subject: "Vraag over planning", "body-plain": "Wanneer komt de monteur?\n\n> oude tekst", "stripped-text": "Wanneer komt de monteur?", "Message-Id": "<abc@x>" });
    expect((await post(body)).statusCode).toBe(200);
    // Dubbele aflevering: genegeerd
    await post(mailgunForm({ from: "klant@example.nl", recipient: "service@mail.gecko.nl", subject: "Vraag over planning", "body-plain": "x", "Message-Id": "<abc@x>" }));

    const list = (await call("GET", "/inbox?status=new")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ customerId: c.id, fromName: "Kees Inbox", text: "Wanneer komt de monteur?" });
    expect((await call("GET", "/notifications")).json().items[0].title).toMatch(/Nieuwe e-mail van Kees Inbox/);
    expect((await call("GET", `/customers/${c.id}/timeline`)).json().some((e: { title: string }) => e.title.startsWith("E-mail van klant"))).toBe(true);

    const r = await call("POST", `/inbox/${list[0].id}/reply`, { text: "Volgende week dinsdag." });
    expect(r.statusCode, r.body).toBe(200);
    expect(mail.sent.at(-1)).toMatchObject({ to: "klant@example.nl", subject: "Re: Vraag over planning" });
    expect((await call("GET", "/inbox?status=new")).json()).toHaveLength(0);
  });

  it("multipart met bijlage (zoals Mailgun forward) wordt ook verwerkt", async () => {
    const qs = new URLSearchParams(mailgunForm({ from: "iemand@example.nl", recipient: "service@mail.gecko.nl", subject: "Met foto", "body-plain": "Zie bijlage", "attachment-count": "1", "Message-Id": "<m2@x>" }));
    const boundary = "----gecko";
    let body = "";
    for (const [k, v] of qs) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="attachment-1"; filename="foto.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEGDATA\r\n--${boundary}--\r\n`;
    const res = await ctx.app.inject({ method: "POST", url: "/api/public/inbound/mailgun", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const list = (await call("GET", "/inbox?status=new")).json();
    expect(list[0]).toMatchObject({ subject: "Met foto", customerId: null, attachmentCount: "1" });
  });
});
