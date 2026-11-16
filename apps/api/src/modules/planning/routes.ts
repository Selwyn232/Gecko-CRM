import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import type { EmailTransport } from "../email/transport.js";
import { listFiles } from "../files/storage.js";
import {
  cancelAppointment,
  findSlots,
  getAppointment,
  getReport,
  listAppointments,
  listAvailability,
  listPenalties,
  listRegions,
  listReports,
  reviewReport,
  saveRegion,
  scheduleAppointment,
  setAvailability,
  toPlan,
  waivePenalty,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");
const Type = z.enum(["survey", "installation"]);
export const AvailabilityEntries = z.array(
  z.object({ regionId: z.string().uuid(), date: IsoDate, surveySlots: z.number().int().min(0).max(50), installationSlots: z.number().int().min(0).max(50) }),
).max(1000);
const RegionBody = z.object({
  name: z.string().min(1).max(100),
  postalRanges: z.array(z.tuple([z.number().int(), z.number().int()])).min(1).max(100),
  isActive: z.boolean().optional(),
});

export const planningRoutes: FastifyPluginAsyncZod<{ db: Db; emailTransport: EmailTransport | null }> = async (app, { db, emailTransport }) => {
  const read = requirePermission("planning.read");
  const manage = requirePermission("planning.manage");

  app.get("/regions", { preValidation: read }, async () => listRegions(db));
  app.post("/regions", { preValidation: manage, schema: { body: RegionBody } }, async (req, reply) => {
    reply.code(201);
    return saveRegion(db, req.actor, null, req.body);
  });
  app.patch("/regions/:id", { preValidation: manage, schema: { params: IdParams, body: RegionBody } }, async (req) => saveRegion(db, req.actor, req.params.id, req.body));

  app.get(
    "/planning/availability",
    { preValidation: read, schema: { querystring: z.object({ from: IsoDate, to: IsoDate, partnerId: z.string().uuid().optional() }) } },
    async (req) => listAvailability(db, req.query),
  );
  app.put(
    "/planning/availability",
    { preValidation: manage, schema: { body: z.object({ partnerId: z.string().uuid(), entries: AvailabilityEntries }) } },
    async (req) => {
      await setAvailability(db, req.actor, req.body.partnerId, req.body.entries);
      return { ok: true };
    },
  );

  app.get("/planning/to-plan", { preValidation: read, schema: { querystring: z.object({ type: Type }) } }, async (req) => toPlan(db, req.query.type));
  app.get(
    "/planning/slots",
    { preValidation: read, schema: { querystring: z.object({ projectId: z.string().uuid(), type: Type }) } },
    async (req) => findSlots(db, req.query.projectId, req.query.type),
  );

  app.get(
    "/appointments",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          partnerId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          status: z.enum(["planned", "completed", "canceled", "partner_no_show"]).optional(),
        }),
      },
    },
    async (req) => listAppointments(db, req.query),
  );
  app.get("/appointments/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getAppointment(db, req.params.id));
  app.post(
    "/projects/:id/appointments",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({
          type: Type,
          date: IsoDate,
          partnerId: z.string().uuid(),
          regionId: z.string().uuid(),
          timeWindow: z.enum(["morning", "afternoon", "day"]).default("day"),
          notes: z.string().max(2000).nullish(),
        }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return scheduleAppointment(db, emailTransport, req.actor, req.params.id, req.body);
    },
  );
  app.post(
    "/appointments/:id/cancel",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({ reason: z.string().min(3).max(500), partnerNoShow: z.boolean().optional(), notifyCustomer: z.boolean().optional() }),
      },
    },
    async (req) => cancelAppointment(db, emailTransport, req.actor, req.params.id, req.body),
  );

  app.get(
    "/reports",
    {
      preValidation: read,
      schema: { querystring: z.object({ review: z.enum(["pending", "approved", "rejected"]).optional(), projectId: z.string().uuid().optional() }) },
    },
    async (req) => listReports(db, req.query),
  );
  app.get("/reports/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => {
    const report = await getReport(db, req.params.id);
    return { ...report, files: await listFiles(db, "appointment", report.appointmentId) };
  });
  app.post(
    "/reports/:id/review",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ approve: z.boolean(), note: z.string().max(2000).nullish() }) } },
    async (req) => reviewReport(db, req.actor, req.params.id, req.body),
  );

  app.get(
    "/penalties",
    { preValidation: read, schema: { querystring: z.object({ partnerId: z.string().uuid().optional(), status: z.enum(["open", "settled", "waived"]).optional() }) } },
    async (req) => listPenalties(db, req.query),
  );
  app.post(
    "/penalties/:id/waive",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ reason: z.string().min(3).max(500) }) } },
    async (req) => waivePenalty(db, req.actor, req.params.id, req.body.reason),
  );
};
