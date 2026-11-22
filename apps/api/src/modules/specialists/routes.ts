import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { forbidden } from "../../lib/errors.js";
import type { EmailTransport } from "../email/transport.js";
import { customersOf, setCustomerSpecialist, specialistOverview, specialistPhoto, transferCustomers, updateSpecialist } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });

export const specialistRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const manage = requirePermission("specialists.manage");
  const deps = { emailTransport, config };

  /** Dashboard manager klantenservice: bezetting per specialist. */
  app.get("/specialists", { preValidation: manage }, async () => specialistOverview(db));
  app.get("/specialists/:id/customers", { preValidation: manage, schema: { params: IdParams } }, async (req) => customersOf(db, req.params.id));

  /** Maximum en nieuwe klanten aan/uit (manager). De profielfoto is altijd een eigen selfie (B88, PUT /auth/me/photo). */
  app.patch(
    "/specialists/:id",
    {
      schema: {
        params: IdParams,
        body: z.object({
          maxCustomers: z.number().int().min(1).max(10000).nullable().optional(),
          acceptsNewCustomers: z.boolean().optional(),
        }).strict(),
      },
    },
    async (req) => {
      if (!req.actor.permissions.has("specialists.manage")) throw forbidden("forbidden", "Alleen de manager klantenservice kan dit wijzigen");
      return updateSpecialist(db, req.actor, req.params.id, req.body);
    },
  );

  /** Klanten overzetten (bij afwezigheid of herverdeling); klanten krijgen bericht met hun nieuwe contactpersoon. */
  app.post(
    "/specialists/transfer",
    {
      preValidation: manage,
      schema: {
        body: z.object({
          fromUserId: z.string().uuid().nullish(),
          customerIds: z.array(z.string().uuid()).max(5000).optional(),
          toUserId: z.string().uuid(),
          notify: z.boolean().optional(),
        }),
      },
    },
    async (req) => transferCustomers(db, deps, req.actor, req.body),
  );

  app.put(
    "/customers/:id/specialist",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ userId: z.string().uuid().nullable(), notify: z.boolean().optional() }) } },
    async (req) => setCustomerSpecialist(db, deps, req.actor, req.params.id, req.body.userId, req.body.notify ?? true),
  );

  /** Pasfoto in e-mails aan klanten. */
  app.get("/public/specialists/:id/photo", { config: { auth: "public" }, schema: { params: IdParams } }, async (req, reply) => {
    const p = await specialistPhoto(db, req.params.id);
    reply.header("content-type", p.contentType).header("cache-control", "public, max-age=86400");
    return reply.send(p.body);
  });
};
