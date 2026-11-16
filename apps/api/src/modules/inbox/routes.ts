import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { forbidden } from "../../lib/errors.js";
import type { EmailTransport } from "../email/transport.js";
import { listInbound, receiveInbound, replyInbound, updateInbound, verifyMailgunSignature } from "./service.js";

/** Webhook van Mailgun (route "forward"); eigen scope zodat form-/multipart-parsing alleen hier geldt. */
export const inboundWebhook: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (app, { db, config }) => {
  await app.register(formbody);
  await app.register(multipart, { attachFieldsToBody: "keyValues", limits: { fileSize: 15 * 1024 * 1024, files: 10, fields: 60, fieldSize: 1_000_000 } });
  app.post("/public/inbound/mailgun", { config: { auth: "public", rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const key = config.MAILGUN_WEBHOOK_SIGNING_KEY;
    if (!key) throw forbidden("inbound_disabled", "Inkomende e-mail is niet ingesteld");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const f = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    if (!verifyMailgunSignature(key, f("timestamp"), f("token"), f("signature"))) throw forbidden("bad_signature", "Ongeldige handtekening");
    await receiveInbound(db, {
      from: f("from") || f("sender"),
      to: f("recipient") || f("To"),
      subject: f("subject"),
      strippedText: f("stripped-text"),
      bodyPlain: f("body-plain"),
      messageId: f("Message-Id") || null,
      attachmentCount: Number(f("attachment-count") || 0),
    });
    reply.code(200);
    return { ok: true };
  });
};

export const inboxRoutes: FastifyPluginAsyncZod<{ db: Db; emailTransport: EmailTransport | null }> = async (app, { db, emailTransport }) => {
  const read = requirePermission("customers.read");
  const manage = requirePermission("customers.manage");
  app.get("/inbox", { preValidation: read, schema: { querystring: z.object({ status: z.enum(["new", "handled"]).optional(), customerId: z.string().uuid().optional() }) } }, async (req) =>
    listInbound(db, req.query),
  );
  app.patch(
    "/inbox/:id",
    { preValidation: manage, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ customerId: z.string().uuid().nullish(), status: z.enum(["new", "handled"]).optional() }) } },
    async (req) => updateInbound(db, req.actor, req.params.id, req.body),
  );
  app.post("/inbox/:id/reply", { preValidation: manage, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ text: z.string().min(1).max(20_000) }) } }, async (req) =>
    replyInbound(db, emailTransport, req.actor, req.params.id, req.body.text),
  );
};
