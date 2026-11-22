import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { conversation, handleWebhook, listConversations, markRead, sendFromCrm, setEnabled, validSignature, whatsappStatus, type MetaWebhook } from "./service.js";
import type { WhatsappTransport } from "./transport.js";

const IdParams = z.object({ id: z.string().uuid() });

export const whatsappRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; whatsappTransport: WhatsappTransport | null }> = async (app, { db, config, whatsappTransport }) => {
  const read = requirePermission("customers.read");
  const manage = requirePermission("customers.manage");
  const deps = { whatsappTransport, config };

  app.get("/whatsapp/status", { preValidation: read }, async () => whatsappStatus(db, config));
  app.get("/whatsapp/conversations", { preValidation: read }, async (req) => listConversations(db, req.actor));

  app.get(
    "/customers/:id/whatsapp",
    { preValidation: read, schema: { params: IdParams, querystring: z.object({ markRead: z.coerce.boolean().optional() }) } },
    async (req) => {
      if (req.query.markRead) await markRead(db, req.params.id);
      return conversation(db, req.params.id);
    },
  );
  app.post(
    "/customers/:id/whatsapp",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ text: z.string().max(4096).optional(), invite: z.boolean().optional() }) } },
    async (req) => sendFromCrm(db, deps, req.actor, req.params.id, req.body),
  );
  app.put(
    "/customers/:id/whatsapp/enabled",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ enabled: z.boolean() }) } },
    async (req) => {
      await setEnabled(db, req.actor, req.params.id, req.body.enabled);
      return { ok: true };
    },
  );

  // Webhook van Meta: eigen JSON-verwerking, zodat de ruwe body beschikbaar is voor de handtekeningcontrole.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    /** Aanmelden van de webhook bij Meta (eenmalig): Meta stuurt de verify token mee en verwacht de challenge terug. */
    hook.get("/public/whatsapp/webhook", { config: { auth: "public" } }, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (config.WHATSAPP_VERIFY_TOKEN && q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WHATSAPP_VERIFY_TOKEN) {
        return reply.type("text/plain").send(q["hub.challenge"] ?? "");
      }
      return reply.code(403).send("forbidden");
    });
    hook.post("/public/whatsapp/webhook", { config: { auth: "public", rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
      if (!config.WHATSAPP_APP_SECRET || !validSignature(config.WHATSAPP_APP_SECRET, raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        return reply.code(401).send({ error: { code: "invalid_signature", message: "Ongeldige handtekening" } });
      }
      await handleWebhook(db, deps, req.body as MetaWebhook);
      return reply.code(200).send({ ok: true });
    });
  });
};
