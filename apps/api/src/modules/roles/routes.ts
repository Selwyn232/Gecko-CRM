import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { createRole, deleteRole, getRole, listRoles, updateRole } from "./service.js";

const RoleBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/, "Alleen kleine letters, cijfers en _"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  permissions: z.array(z.string()),
});
const IdParams = z.object({ id: z.string().uuid() });

export const roleRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const manage = requirePermission("roles.manage");

  app.get("/roles", { preValidation: requirePermission("users.read") }, async () => listRoles(db));

  app.get("/roles/:id", { preValidation: requirePermission("users.read"), schema: { params: IdParams } }, async (req) =>
    getRole(db, req.params.id),
  );

  app.post("/roles", { preValidation: manage, schema: { body: RoleBody } }, async (req, reply) => {
    reply.code(201);
    return createRole(db, req.actor, req.body);
  });

  app.patch(
    "/roles/:id",
    { preValidation: manage, schema: { params: IdParams, body: RoleBody.omit({ key: true }).partial() } },
    async (req) => updateRole(db, req.actor, req.params.id, req.body),
  );

  app.delete("/roles/:id", { preValidation: manage, schema: { params: IdParams } }, async (req, reply) => {
    await deleteRole(db, req.actor, req.params.id);
    reply.code(204);
  });
};
