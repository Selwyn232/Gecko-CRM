import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { badRequest } from "../../lib/errors.js";
import { users } from "../auth/schema.js";
import { listEmails } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { listTemplates, previewMessage, saveTemplate, sendTestMessage } from "./service.js";
import { FIXED_KEYS, PLACEHOLDERS } from "./templates.js";

const Content = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(10_000) });
const Template = Content.extend({ isActive: z.boolean() });

export const messageRoutes: FastifyPluginAsyncZod<{ db: Db; emailTransport: EmailTransport | null }> = async (app, { db, emailTransport }) => {
  const read = requirePermission("projects.read");
  const manage = requirePermission("journeys.manage");

  app.get("/message-templates", { preValidation: read }, async () => ({ ...(await listTemplates(db)), placeholders: PLACEHOLDERS }));

  app.put(
    "/message-templates/fixed/:key",
    { preValidation: manage, schema: { params: z.object({ key: z.enum(FIXED_KEYS as [string, ...string[]]) }), body: Template } },
    async (req) => saveTemplate(db, req.actor, { key: req.params.key as (typeof FIXED_KEYS)[number] }, req.body),
  );
  app.put(
    "/message-templates/status/:id",
    { preValidation: manage, schema: { params: z.object({ id: z.string().uuid() }), body: Template } },
    async (req) => saveTemplate(db, req.actor, { journeyStatusId: req.params.id }, req.body),
  );
  app.post("/message-templates/preview", { preValidation: read, schema: { body: Content } }, async (req) => previewMessage(db, req.body));
  app.post("/message-templates/test", { preValidation: manage, schema: { body: Content } }, async (req) => {
    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.actor.userId!));
    if (!me?.email) throw badRequest("no_email", "Je account heeft geen e-mailadres; vul dat eerst in bij Gebruikers");
    const r = await sendTestMessage(db, emailTransport, me.email, req.body);
    return { to: me.email, status: r.status, error: r.error };
  });

  /** Alle e-mails aan een klant, nieuwste eerst (zonder html). */
  app.get("/customers/:id/emails", { preValidation: requirePermission("customers.read"), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) =>
    (await listEmails(db, { customerId: req.params.id })).map(({ html: _h, ...rest }) => rest),
  );
};
