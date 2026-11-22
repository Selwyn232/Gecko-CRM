import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate, todayIso } from "../../lib/dates.js";
import { forbidden } from "../../lib/errors.js";
import type { EmailTransport } from "../email/transport.js";
import { organizations } from "../organizations/schema.js";
import { techniciansOf } from "../planning/service.js";
import { addTechnician, checkIn, enRoute, lastLocations, listTechnicians, recordLocation, technicianDay, updateTechnician } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const Loc = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000).nullish() });

/** B87: monteurs beheren (partner), monteursportaal (monteur) en overzicht (planner). */
export const technicianRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const portal = requirePermission("partner.portal");
  const tech = requirePermission("technician.portal");
  const read = requirePermission("planning.read");

  async function partnerId(req: FastifyRequest) {
    const orgId = req.actor.organizationId;
    if (!orgId) throw forbidden();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org || org.type !== "installation_partner" || !org.isActive) throw forbidden("not_partner", "Alleen voor installatiepartners");
    return orgId;
  }

  // Partner: eigen monteurs
  app.get("/partner/technicians", { preValidation: portal }, async (req) => listTechnicians(db, await partnerId(req)));
  app.post(
    "/partner/technicians",
    { preValidation: portal, schema: { body: z.object({ name: z.string().min(2).max(100), email: z.string().email().max(200) }) } },
    async (req, reply) => {
      reply.code(201);
      return addTechnician(db, { transport: emailTransport, baseUrl: config.APP_BASE_URL }, req.actor, await partnerId(req), req.body);
    },
  );
  app.patch(
    "/partner/technicians/:id",
    { preValidation: portal, schema: { params: IdParams, body: z.object({ isTechnician: z.boolean().optional(), isActive: z.boolean().optional() }) } },
    async (req) => updateTechnician(db, req.actor, await partnerId(req), req.params.id, req.body),
  );
  app.get("/partner/technicians/locations", { preValidation: portal }, async (req) =>
    lastLocations(db, (await techniciansOf(db, [await partnerId(req)])).map((t) => t.id)),
  );

  // Planner: monteurs van een partner en hun laatste locatie
  app.get("/planning/technicians", { preValidation: read, schema: { querystring: z.object({ partnerId: z.string().uuid() }) } }, async (req) =>
    techniciansOf(db, [req.query.partnerId]),
  );
  app.get("/planning/technicians/locations", { preValidation: read, schema: { querystring: z.object({ partnerId: z.string().uuid() }) } }, async (req) =>
    lastLocations(db, (await techniciansOf(db, [req.query.partnerId])).map((t) => t.id)),
  );

  // Monteur: eigen dag, locatie, onderweg en aanmelden
  app.get(
    "/technician/day",
    { preValidation: tech, schema: { querystring: z.object({ date: z.string().refine(isIsoDate).optional() }) } },
    async (req) => technicianDay(db, req.actor.userId!, req.query.date ?? todayIso()),
  );
  app.post("/technician/location", { preValidation: tech, schema: { body: Loc } }, async (req) => recordLocation(db, req.actor.userId!, req.body));
  app.post("/technician/appointments/:id/en-route", { preValidation: tech, schema: { params: IdParams, body: Loc.nullish() } }, async (req) =>
    enRoute(db, emailTransport, req.actor, req.params.id, req.body ?? null),
  );
  app.post("/technician/appointments/:id/check-in", { preValidation: tech, schema: { params: IdParams, body: Loc.nullish() } }, async (req) =>
    checkIn(db, req.actor, req.params.id, req.body ?? null),
  );
};
