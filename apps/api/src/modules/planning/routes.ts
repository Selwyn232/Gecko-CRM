import { keepOwnProjects } from "../specialists/service.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import type { EmailTransport } from "../email/transport.js";
import { listFiles } from "../files/storage.js";
import {
  cancelAppointment,
  getAppointment,
  getPartnerRegions,
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
  setPartnerRegions,
  toPlan,
  suggestSlots,
  waivePenalty,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");
const Type = z.enum(["survey", "installation"]);
export const BlockChanges = z.array(z.object({ date: IsoDate, part: z.enum(["08", "10", "12", "14"]), available: z.boolean() })).max(2000);
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
    { preValidation: read, schema: { querystring: z.object({ from: IsoDate, to: IsoDate, partnerId: z.string().uuid().optional(), technicianId: z.string().uuid().optional() }) } },
    async (req) => listAvailability(db, req.query),
  );
  app.put(
    "/planning/availability",
    { preValidation: manage, schema: { body: z.object({ partnerId: z.string().uuid(), technicianId: z.string().uuid(), changes: BlockChanges }) } },
    async (req) => {
      await setAvailability(db, req.actor, req.body.partnerId, req.body.technicianId, req.body.changes);
      return { ok: true };
    },
  );
  app.get("/planning/partner-regions/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getPartnerRegions(db, req.params.id));
  app.put(
    "/planning/partner-regions/:id",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ regionIds: z.array(z.string().uuid()).max(200) }) } },
    async (req) => setPartnerRegions(db, req.actor, req.params.id, req.body.regionIds),
  );

  app.get("/planning/to-plan", { preValidation: read, schema: { querystring: z.object({ type: Type }) } }, async (req) => keepOwnProjects(db, req.actor, await toPlan(db, req.query.type)));
  app.get(
    "/planning/slots",
    { preValidation: read, schema: { querystring: z.object({ projectId: z.string().uuid(), type: Type }) } },
    // Vrije momenten plus een voorstel (beste 3) met uitleg.
    async (req) => suggestSlots(db, req.query.projectId, req.query.type),
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
    async (req) => keepOwnProjects(db, req.actor, await listAppointments(db, req.query)),
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
          technicianId: z.string().uuid(),
          startMinute: z.number().int().min(480).max(960),
          partnerId: z.string().uuid().nullish(),
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
    async (req) => {
      const list = await listReports(db, req.query);
      const own = new Set((await keepOwnProjects(db, req.actor, list.map((r) => ({ projectId: r.appointment.projectId, id: r.id })))).map((x) => x.id));
      return list.filter((r) => own.has(r.id));
    },
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
