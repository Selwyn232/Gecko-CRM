import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { organizationType } from "./schema.js";
import { createOrganization, getOrganization, listOrganizations, updateOrganization } from "./service.js";

const OrgBody = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(organizationType.enumValues),
  kvkNumber: z.string().max(20).nullish(),
  vatNumber: z.string().max(20).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(),
  isActive: z.boolean().optional(),
});
const IdParams = z.object({ id: z.string().uuid() });

export const organizationRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("organizations.read");
  const manage = requirePermission("organizations.manage");

  app.get(
    "/organizations",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          type: z.enum(organizationType.enumValues).optional(),
          isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
        }),
      },
    },
    async (req) => listOrganizations(db, req.query),
  );

  app.get("/organizations/:id", { preValidation: read, schema: { params: IdParams } }, async (req) =>
    getOrganization(db, req.params.id),
  );

  app.post("/organizations", { preValidation: manage, schema: { body: OrgBody } }, async (req, reply) => {
    reply.code(201);
    return createOrganization(db, req.actor, req.body);
  });

  app.patch(
    "/organizations/:id",
    { preValidation: manage, schema: { params: IdParams, body: OrgBody.omit({ type: true }).partial() } },
    async (req) => updateOrganization(db, req.actor, req.params.id, req.body),
  );
};
