import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { JOURNEY_EVENTS } from "./events.js";
import { createChannelJourney, createStatus, deleteChannelJourney, deleteStatus, getJourney, listJourneys, setTransitions, updateStatus } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const COLORS = ["gray", "blue", "green", "yellow", "red", "purple"] as const;
const StatusBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/, "Alleen kleine letters, cijfers en _"),
  name: z.string().min(1).max(100),
  phase: z.string().min(1).max(50),
  color: z.enum(COLORS).optional(),
  sortOrder: z.number().int().optional(),
  isInitial: z.boolean().optional(),
  isFinal: z.boolean().optional(),
  isActive: z.boolean().optional(),
  invoiceTrigger: z.enum(["deposit", "final"]).nullish(),
  autoOnEvents: z.array(z.enum(JOURNEY_EVENTS)).optional(),
});

export const journeyRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("projects.read");
  const manage = requirePermission("journeys.manage");

  app.get("/journeys", { preValidation: read }, async () => listJourneys(db));
  const ChannelQuery = z.object({ salesChannelId: z.string().uuid().optional() });
  app.get("/journeys/:id", { preValidation: read, schema: { params: IdParams, querystring: ChannelQuery } }, async (req) =>
    getJourney(db, req.params.id, req.query.salesChannelId ?? null),
  );
  app.post(
    "/journeys/:id/statuses",
    { preValidation: manage, schema: { params: IdParams, body: StatusBody.extend({ salesChannelId: z.string().uuid().nullish() }) } },
    async (req, reply) => {
      const { salesChannelId, ...input } = req.body;
      reply.code(201);
      return createStatus(db, req.actor, req.params.id, input, salesChannelId ?? null);
    },
  );
  /** Eigen klantreis voor een verkoopkanaal (kopie van de standaard), of weer verwijderen. */
  const ChannelParams = z.object({ id: z.string().uuid(), channelId: z.string().uuid() });
  app.post("/journeys/:id/channels/:channelId", { preValidation: manage, schema: { params: ChannelParams } }, async (req, reply) => {
    reply.code(201);
    return createChannelJourney(db, req.actor, req.params.id, req.params.channelId);
  });
  app.delete("/journeys/:id/channels/:channelId", { preValidation: manage, schema: { params: ChannelParams } }, async (req, reply) => {
    await deleteChannelJourney(db, req.actor, req.params.id, req.params.channelId);
    reply.code(204);
  });
  app.patch(
    "/journey-statuses/:id",
    { preValidation: manage, schema: { params: IdParams, body: StatusBody.omit({ key: true }).partial() } },
    async (req) => updateStatus(db, req.actor, req.params.id, req.body),
  );
  app.delete("/journey-statuses/:id", { preValidation: manage, schema: { params: IdParams } }, async (req, reply) => {
    await deleteStatus(db, req.actor, req.params.id);
    reply.code(204);
  });
  app.put(
    "/journey-statuses/:id/transitions",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ toStatusIds: z.array(z.string().uuid()) }) } },
    async (req) => ({ toStatusIds: await setTransitions(db, req.actor, req.params.id, req.body.toStatusIds) }),
  );
};
