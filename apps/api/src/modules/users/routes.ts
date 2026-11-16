import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import {
  adminResetMfa,
  adminResetPassword,
  createUser,
  getUser,
  listUsers,
  unlockUser,
  updateUser,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });

export const userRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("users.read");
  const manage = requirePermission("users.manage");

  app.get(
    "/users",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          organizationId: z.string().uuid().optional(),
          roleId: z.string().uuid().optional(),
          search: z.string().max(100).optional(),
        }),
      },
    },
    async (req) => listUsers(db, req.query),
  );

  app.get("/users/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getUser(db, req.params.id));

  app.post(
    "/users",
    {
      preValidation: manage,
      schema: {
        body: z.object({
          organizationId: z.string().uuid(),
          email: z.string().email().nullish(),
          username: z.string().regex(/^[a-zA-Z0-9._-]{2,50}$/, "Alleen letters, cijfers, punt, - en _").nullish(),
          name: z.string().min(1).max(200),
          password: z.string(),
          roleIds: z.array(z.string().uuid()).default([]),
          mfaRequired: z.boolean().optional(),
          mustChangePassword: z.boolean().optional(),
          advisorId: z.string().uuid().nullish(),
        }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return createUser(db, req.actor, req.body);
    },
  );

  app.patch(
    "/users/:id",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({
          name: z.string().min(1).max(200).optional(),
          email: z.string().email().nullish(),
          username: z.string().regex(/^[a-zA-Z0-9._-]{2,50}$/, "Alleen letters, cijfers, punt, - en _").nullish(),
          mfaRequired: z.boolean().optional(),
          organizationId: z.string().uuid().optional(),
          isActive: z.boolean().optional(),
          roleIds: z.array(z.string().uuid()).optional(),
          advisorId: z.string().uuid().nullish(),
        }),
      },
    },
    async (req) => updateUser(db, req.actor, req.params.id, req.body),
  );

  app.post(
    "/users/:id/reset-password",
    {
      preValidation: manage,
      schema: { params: IdParams, body: z.object({ password: z.string(), mustChangePassword: z.boolean().default(true) }) },
    },
    async (req) => {
      await adminResetPassword(db, req.actor, req.params.id, req.body.password, req.body.mustChangePassword);
      return { ok: true };
    },
  );

  app.post("/users/:id/reset-mfa", { preValidation: manage, schema: { params: IdParams } }, async (req) => {
    await adminResetMfa(db, req.actor, req.params.id);
    return { ok: true };
  });

  app.post("/users/:id/unlock", { preValidation: manage, schema: { params: IdParams } }, async (req) => {
    await unlockUser(db, req.actor, req.params.id);
    return { ok: true };
  });
};
