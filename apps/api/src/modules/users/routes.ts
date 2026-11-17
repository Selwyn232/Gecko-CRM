import { and, desc, eq, isNull } from "drizzle-orm";
import { apiKeys, users } from "../auth/schema.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";
import { notFound } from "../../lib/errors.js";
import type { FastifyRequest } from "fastify";
import { loadPermissions, missingPermissions, permissionsOfRoles } from "../auth/access.js";
import type { Permission } from "../auth/permissions.js";
import { forbidden } from "../../lib/errors.js";
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

/** Rollen toekennen of een account resetten mag alleen als je zelf minstens dezelfde rechten hebt (geen escalatie). */
async function assertNoEscalation(db: Db, req: FastifyRequest, opts: { roleIds?: string[]; targetUserId?: string }) {
  const wanted = new Set<Permission>();
  if (opts.roleIds) for (const p of await permissionsOfRoles(db, opts.roleIds)) wanted.add(p);
  if (opts.targetUserId) for (const p of await loadPermissions(db, opts.targetUserId)) wanted.add(p);
  const missing = missingPermissions(req.actor.permissions, wanted);
  if (missing.length) throw forbidden("privilege_escalation", "Je kunt geen rechten geven of een account beheren met meer rechten dan je zelf hebt");
}

export const apiKeyRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const manage = requirePermission("users.manage");
  const IdP = z.object({ id: z.string().uuid() });
  app.get("/users/:id/api-keys", { preValidation: manage, schema: { params: IdP } }, async (req) =>
    db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.userId, req.params.id))
      .orderBy(desc(apiKeys.createdAt)),
  );
  /** Nieuwe sleutel; alleen nu zichtbaar. Niet voor accounts met meer rechten dan jijzelf. */
  app.post("/users/:id/api-keys", { preValidation: manage, schema: { params: IdP, body: z.object({ name: z.string().trim().min(2).max(100) }) } }, async (req, reply) => {
    const [u] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!u) throw notFound("Gebruiker");
    await assertNoEscalation(db, req, { targetUserId: u.id });
    const key = `gk_${randomToken(24)}`;
    const [row] = await db.insert(apiKeys).values({ userId: u.id, name: req.body.name, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: req.actor.userId }).returning();
    await recordAudit(db, req.actor, { action: "api_key.created", entityType: "user", entityId: u.id, metadata: { keyId: row!.id, name: req.body.name } });
    reply.code(201);
    return { id: row!.id, name: row!.name, prefix: row!.prefix, key };
  });
  app.post("/api-keys/:id/revoke", { preValidation: manage, schema: { params: IdP } }, async (req) => {
    const [row] = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, req.params.id), isNull(apiKeys.revokedAt))).returning();
    if (!row) throw notFound("API-sleutel");
    await recordAudit(db, req.actor, { action: "api_key.revoked", entityType: "user", entityId: row.userId, metadata: { keyId: row.id } });
    return { ok: true };
  });
};

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
          email: z.string().trim().email("Ongeldig e-mailadres"),
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
      await assertNoEscalation(db, req, { roleIds: req.body.roleIds });
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
          email: z.string().trim().email("Ongeldig e-mailadres").optional(),
          mfaRequired: z.boolean().optional(),
          organizationId: z.string().uuid().optional(),
          isActive: z.boolean().optional(),
          roleIds: z.array(z.string().uuid()).optional(),
          advisorId: z.string().uuid().nullish(),
        }),
      },
    },
    async (req) => {
      await assertNoEscalation(db, req, { roleIds: req.body.roleIds, targetUserId: req.params.id });
      return updateUser(db, req.actor, req.params.id, req.body);
    },
  );

  app.post(
    "/users/:id/reset-password",
    {
      preValidation: manage,
      schema: { params: IdParams, body: z.object({ password: z.string(), mustChangePassword: z.boolean().default(true) }) },
    },
    async (req) => {
      await assertNoEscalation(db, req, { targetUserId: req.params.id });
      await adminResetPassword(db, req.actor, req.params.id, req.body.password, req.body.mustChangePassword);
      return { ok: true };
    },
  );

  app.post("/users/:id/reset-mfa", { preValidation: manage, schema: { params: IdParams } }, async (req) => {
    await assertNoEscalation(db, req, { targetUserId: req.params.id });
    await adminResetMfa(db, req.actor, req.params.id);
    return { ok: true };
  });

  app.post("/users/:id/unlock", { preValidation: manage, schema: { params: IdParams } }, async (req) => {
    await unlockUser(db, req.actor, req.params.id);
    return { ok: true };
  });
};
