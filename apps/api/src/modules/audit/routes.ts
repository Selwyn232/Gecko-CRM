import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { listAudit } from "./service.js";

export const auditRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/audit-log",
    {
      preValidation: requirePermission("audit.read"),
      schema: {
        querystring: z.object({
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          actorUserId: z.string().uuid().optional(),
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => listAudit(db, req.query),
  );
};
