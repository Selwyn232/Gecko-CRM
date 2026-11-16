import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { addNote, customerTimeline, search } from "./service.js";

export const timelineRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get("/customers/:id/timeline", { preValidation: requirePermission("customers.read"), schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) =>
    customerTimeline(db, req.actor, req.params.id),
  );
  app.post(
    "/customers/:id/notes",
    {
      preValidation: requirePermission("customers.manage"),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ kind: z.enum(["note", "call"]), body: z.string().trim().min(1).max(5000), projectId: z.string().uuid().nullish() }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return addNote(db, req.actor, req.params.id, req.body);
    },
  );
  /** Zoekbalk: resultaten volgens de rechten van de gebruiker. */
  app.get("/search", { schema: { querystring: z.object({ q: z.string().max(100) }) } }, async (req) => search(db, req.actor, req.query.q));
};
