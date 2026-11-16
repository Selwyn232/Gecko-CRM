import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { anonymizeCustomer, exportCustomerData } from "./service.js";

/** AVG: inzage-export en anonimiseren. Alleen met recht om klanten te beheren; beide gelogd. */
export const privacyRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const manage = requirePermission("customers.manage");
  app.get("/customers/:id/privacy-export", { preValidation: manage, schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const data = await exportCustomerData(db, req.actor, req.params.id);
    reply.header("content-disposition", `attachment; filename="inzage-${req.params.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });
  app.post(
    "/customers/:id/anonymize",
    { preValidation: manage, schema: { params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().trim().min(3).max(500), confirm: z.literal("ANONIMISEREN") }) } },
    async (req) => anonymizeCustomer(db, req.actor, req.params.id, req.body.reason),
  );
};
