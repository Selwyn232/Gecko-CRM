import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { getSetting } from "../settings/service.js";
import { createTestScenario } from "./service.js";

export const testingRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  /** Of de testmodus aan staat (voor de balk bovenin). Voor iedereen met volledige toegang. */
  app.get("/testing/status", async () => ({ testMode: await getSetting(db, "test.mode") }));

  app.post(
    "/testing/scenario",
    {
      preValidation: requirePermission("settings.manage"),
      schema: {
        body: z.object({
          productGroupId: z.string().uuid(),
          email: z.string().email(),
          postalCode: z.string().regex(/^\s*[1-9]\d{3}\s*[a-zA-Z]{2}\s*$/, "Ongeldige postcode"),
          /** Leeg = "Greenteam (test)". */
          salesChannelId: z.string().uuid().nullish(),
        }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return createTestScenario(db, req.actor, req.body);
    },
  );
};
