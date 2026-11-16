import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import { users } from "../auth/schema.js";
import { organizations } from "../organizations/schema.js";
import { and, asc, eq } from "drizzle-orm";
import { createTask, listNotifications, listTasks, markRead, updateTask } from "./service.js";

const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");

export const taskRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("customers.read");
  const manage = requirePermission("customers.manage");

  app.get(
    "/tasks",
    { preValidation: read, schema: { querystring: z.object({ mine: z.coerce.boolean().optional(), customerId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), open: z.coerce.boolean().optional() }) } },
    async (req) => listTasks(db, { ...req.query, assigneeUserId: req.query.mine ? req.actor.userId! : undefined }),
  );
  app.post(
    "/tasks",
    {
      preValidation: manage,
      schema: {
        body: z.object({
          title: z.string().trim().min(2).max(200),
          description: z.string().max(5000).nullish(),
          customerId: z.string().uuid().nullish(),
          projectId: z.string().uuid().nullish(),
          assigneeUserId: z.string().uuid().nullish(),
          dueDate: IsoDate.nullish(),
        }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return createTask(db, req.actor, req.body);
    },
  );
  app.patch(
    "/tasks/:id",
    {
      preValidation: manage,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ title: z.string().trim().min(2).max(200).optional(), description: z.string().max(5000).nullish(), assigneeUserId: z.string().uuid().nullish(), dueDate: IsoDate.nullish(), done: z.boolean().optional() }),
      },
    },
    async (req) => updateTask(db, req.actor, req.params.id, req.body),
  );
  /** Medewerkers om taken aan toe te wijzen. */
  app.get("/tasks/assignees", { preValidation: read }, async () =>
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(and(eq(users.isActive, true), eq(organizations.type, "gecko")))
      .orderBy(asc(users.name)),
  );

  // Meldingen: iedere ingelogde gebruiker, alleen de eigen.
  app.get("/notifications", async (req) => listNotifications(db, req.actor.userId!));
  app.post("/notifications/:id/read", { schema: { params: z.object({ id: z.union([z.string().uuid(), z.literal("all")]) }) } }, async (req) => {
    await markRead(db, req.actor.userId!, req.params.id);
    return { ok: true };
  });
};
