import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { addProperty, createCustomer, getCustomer, listCustomers, updateCustomer, updateProperty } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const PropertyBody = z.object({
  street: z.string().min(1).max(200),
  houseNumber: z.string().min(1).max(10),
  houseNumberAddition: z.string().max(10).nullish(),
  postalCode: z.string().min(4).max(10),
  city: z.string().min(1).max(100),
  country: z.string().length(2).optional(),
  bagId: z.string().max(20).nullish(),
  notes: z.string().max(2000).nullish(),
});
const CustomerBody = z.object({
  firstName: z.string().max(100).nullish(),
  lastName: z.string().min(1).max(100),
  email: z.string().email().nullish().or(z.literal("").transform(() => null)),
  phone: z.string().max(30).nullish(),
  salesChannelId: z.string().uuid().nullish(),
  notes: z.string().max(5000).nullish(),
});

export const customerRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("customers.read");
  const manage = requirePermission("customers.manage");

  app.get(
    "/customers",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          search: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => listCustomers(db, req.query),
  );
  app.get("/customers/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getCustomer(db, req.params.id));
  app.post(
    "/customers",
    { preValidation: manage, schema: { body: CustomerBody.extend({ property: PropertyBody.optional() }) } },
    async (req, reply) => {
      reply.code(201);
      return createCustomer(db, req.actor, req.body);
    },
  );
  app.patch("/customers/:id", { preValidation: manage, schema: { params: IdParams, body: CustomerBody.partial() } }, async (req) =>
    updateCustomer(db, req.actor, req.params.id, req.body),
  );
  app.post("/customers/:id/properties", { preValidation: manage, schema: { params: IdParams, body: PropertyBody } }, async (req, reply) => {
    reply.code(201);
    return addProperty(db, req.actor, req.params.id, req.body);
  });
  app.patch("/properties/:id", { preValidation: manage, schema: { params: IdParams, body: PropertyBody.partial() } }, async (req) =>
    updateProperty(db, req.actor, req.params.id, req.body),
  );
};
