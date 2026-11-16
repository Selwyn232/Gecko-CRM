import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { listSettings, setSetting } from "./service.js";

export const settingsRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get("/settings", { preValidation: requirePermission("settings.manage") }, async () => listSettings(db));
  app.put(
    "/settings/:key",
    { preValidation: requirePermission("settings.manage"), schema: { params: z.object({ key: z.string() }), body: z.object({ value: z.unknown() }) } },
    async (req) => {
      await setSetting(db, req.actor, req.params.key, req.body.value);
      return listSettings(db);
    },
  );
};
