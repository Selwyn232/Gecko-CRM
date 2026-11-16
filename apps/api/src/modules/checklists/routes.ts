import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { listChecklists, saveChecklist } from "./service.js";

export const checklistRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get("/checklists", { preValidation: requirePermission("planning.read") }, async () => listChecklists(db));
  app.put(
    "/checklists/:productGroupId/:type",
    {
      preValidation: requirePermission("journeys.manage"),
      schema: {
        params: z.object({ productGroupId: z.string().uuid(), type: z.enum(["survey", "installation"]) }),
        body: z.object({
          items: z.array(z.object({ label: z.string().min(1).max(200), required: z.boolean() })).max(60),
          minPhotos: z.number().int().min(0).max(30),
        }),
      },
    },
    async (req) => saveChecklist(db, req.actor, req.params.productGroupId, req.params.type, req.body),
  );
};
