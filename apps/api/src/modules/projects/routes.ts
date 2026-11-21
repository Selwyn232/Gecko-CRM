import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { projectCalculation } from "./calculation.js";
import { cancellationPreview, cancelProject } from "./cancel.js";
import { forbidden } from "../../lib/errors.js";
import type { EmailTransport } from "../email/transport.js";
import { paymentMethod } from "./schema.js";
import { changeStatus, createProject, getProject, listProjects, statusCounts, updateProject } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });

export const projectRoutes: FastifyPluginAsyncZod<{ db: Db; emailTransport: EmailTransport | null }> = async (app, { db, emailTransport }) => {
  const read = requirePermission("projects.read");
  const manage = requirePermission("projects.manage");

  app.get(
    "/projects",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          statusId: z.string().uuid().optional(),
          productGroupId: z.string().uuid().optional(),
          partnerId: z.string().uuid().optional(),
          phase: z.string().max(50).optional(),
          search: z.string().max(100).optional(),
          includeFinal: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => listProjects(db, req.query, req.actor),
  );
  app.get(
    "/projects/status-counts",
    { preValidation: read, schema: { querystring: z.object({ productGroupId: z.string().uuid().optional() }) } },
    async (req) => statusCounts(db, req.query.productGroupId, req.actor),
  );
  app.get("/projects/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getProject(db, req.params.id));
  app.get("/projects/:id/cancellation", { preValidation: manage, schema: { params: IdParams } }, async (req) => cancellationPreview(db, req.params.id));
  app.post(
    "/projects/:id/cancel",
    {
      preValidation: manage,
      schema: { params: IdParams, body: z.object({ reason: z.string().trim().min(3, "Geef een reden").max(1000), creditInvoiceIds: z.array(z.string().uuid()).max(20) }) },
    },
    async (req) => {
      if (req.body.creditInvoiceIds.length && !req.actor.permissions.has("invoices.manage")) throw forbidden("no_invoice_rights", "Crediteren vraagt het recht om facturen te beheren");
      return cancelProject(db, emailTransport, req.actor, req.params.id, req.body);
    },
  );
  /** Voor- en nacalculatie; alleen met recht op inkoopprijzen (B24). */
  app.get("/projects/:id/calculation", { preValidation: requirePermission("purchase_prices.read"), schema: { params: IdParams } }, async (req) =>
    projectCalculation(db, req.params.id),
  );
  app.post(
    "/projects",
    {
      preValidation: manage,
      schema: {
        body: z.object({
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          productGroupId: z.string().uuid(),
          salesChannelId: z.string().uuid(),
          installationPartnerId: z.string().uuid().nullish(),
          paymentMethod: z.enum(paymentMethod.enumValues).optional(),
          notes: z.string().max(5000).nullish(),
        }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return createProject(db, req.actor, req.body);
    },
  );
  app.patch(
    "/projects/:id",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({
          installationPartnerId: z.string().uuid().nullish(),
          paymentMethod: z.enum(paymentMethod.enumValues).optional(),
          notes: z.string().max(5000).nullish(),
        }),
      },
    },
    async (req) => updateProject(db, req.actor, req.params.id, req.body),
  );
  app.post(
    "/projects/:id/status",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({ toStatusId: z.string().uuid(), expectedStatusId: z.string().uuid().optional(), note: z.string().max(2000).nullish() }),
      },
    },
    async (req) => changeStatus(db, req.actor, req.params.id, req.body),
  );
};
