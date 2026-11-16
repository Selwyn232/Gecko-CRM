import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { products } from "../catalog/schema.js";
import { files } from "../files/schema.js";
import { listFiles, loadFile, saveFile } from "../files/storage.js";
import { organizations } from "../organizations/schema.js";
import { appointments, reports } from "../planning/schema.js";
import { BlockChanges } from "../planning/routes.js";
import {
  getAppointment,
  getPartnerRegions,
  getReport,
  listAppointments,
  listAvailability,
  listPenalties,
  listRegions,
  setAvailability,
  setPartnerRegions,
  submitReport,
} from "../planning/service.js";
import { projects } from "../projects/schema.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { Decision } from "../selfbilling/routes.js";
import { getSetting } from "../settings/service.js";
import { decideApproval, getSelfBillingInvoice, listSelfBilling, publicView } from "../selfbilling/service.js";
import type { Config } from "../../config.js";
import type { EmailTransport } from "../email/transport.js";

const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");

/**
 * Partnerportaal. Elke route is afgeschermd op de organisatie van de ingelogde partner:
 * een partner ziet en wijzigt uitsluitend zijn eigen afspraken, beschikbaarheid en rapporten.
 */
export const partnerRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const portal = requirePermission("partner.portal");

  /** Organisatie van de ingelogde partner (en controle dat het echt een installatiepartner is). */
  async function partnerId(req: FastifyRequest) {
    const orgId = req.actor.organizationId;
    if (!orgId) throw forbidden();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org || org.type !== "installation_partner" || !org.isActive) throw forbidden("not_partner", "Alleen voor installatiepartners");
    return orgId;
  }

  async function ownAppointment(req: FastifyRequest, appointmentId: string) {
    const pid = await partnerId(req);
    const [a] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    if (!a || a.partnerOrganizationId !== pid) throw notFound("Afspraak");
    return a;
  }

  app.get("/partner/me", { preValidation: portal }, async (req) => {
    const pid = await partnerId(req);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, pid));
    return { organization: { id: org!.id, name: org!.name } };
  });

  app.get(
    "/partner/appointments",
    { preValidation: portal, schema: { querystring: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }) } },
    async (req) => listAppointments(db, { ...req.query, partnerId: await partnerId(req) }),
  );

  app.get("/partner/appointments/:id", { preValidation: portal, schema: { params: IdParams } }, async (req) => {
    const a = await ownAppointment(req, req.params.id);
    const view = await getAppointment(db, a.id);
    // Wat er geïnstalleerd moet worden: regels van de geaccepteerde offerte(s), zonder prijzen.
    const accepted = await db.select().from(quotes).where(and(eq(quotes.projectId, a.projectId), eq(quotes.status, "accepted")));
    const lines = accepted.length
      ? await db
          .select({ description: quoteLines.description, quantity: quoteLines.quantity, code: products.code, kind: quotes.kind })
          .from(quoteLines)
          .innerJoin(products, eq(products.id, quoteLines.productId))
          .innerJoin(quotes, eq(quotes.id, quoteLines.quoteId))
          .where(inArray(quoteLines.quoteId, accepted.map((q) => q.id)))
          .orderBy(asc(quoteLines.sortOrder))
      : [];
    const [project] = await db.select().from(projects).where(eq(projects.id, a.projectId));
    const extraWorkProducts = await db
      .select({ id: products.id, code: products.code, name: products.name, unit: products.unit })
      .from(products)
      .where(and(eq(products.productGroupId, project!.productGroupId), eq(products.type, "extra_work"), eq(products.isActive, true)))
      .orderBy(asc(products.code));
    const [report] = await db.select().from(reports).where(eq(reports.appointmentId, a.id));
    return {
      ...view,
      scope: lines,
      extraWorkProducts,
      files: await listFiles(db, "appointment", a.id),
      reportDetail: report ? await getReport(db, report.id) : null,
    };
  });

  app.post(
    "/partner/appointments/:id/files",
    {
      preValidation: portal,
      bodyLimit: 12 * 1024 * 1024,
      schema: { params: IdParams, body: z.object({ filename: z.string().min(1).max(200), dataBase64: z.string().min(10) }) },
    },
    async (req, reply) => {
      const a = await ownAppointment(req, req.params.id);
      reply.code(201);
      return saveFile(db, { ownerType: "appointment", ownerId: a.id, filename: req.body.filename, dataBase64: req.body.dataBase64, createdBy: req.actor.userId });
    },
  );

  app.post(
    "/partner/appointments/:id/report",
    {
      preValidation: portal,
      schema: {
        params: IdParams,
        body: z.object({
          positive: z.boolean(),
          data: z.object({
            remarks: z.string().max(5000).optional(),
            checklist: z.record(z.string(), z.boolean()).optional(),
            serialNumbers: z.array(z.string().max(100)).max(50).optional(),
            extraWork: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive().max(1000), note: z.string().max(500).optional() })).max(30).optional(),
          }),
          customerSignedName: z.string().max(200).nullish(),
          customerSignatureFileId: z.string().uuid().nullish(),
        }),
      },
    },
    async (req) => {
      const a = await ownAppointment(req, req.params.id);
      if (req.body.customerSignatureFileId) {
        const [f] = await db.select({ ownerId: files.ownerId }).from(files).where(eq(files.id, req.body.customerSignatureFileId));
        if (!f || f.ownerId !== a.id) throw forbidden("invalid_file", "Handtekening hoort niet bij deze afspraak");
      }
      return submitReport(db, req.actor, a.id, req.body);
    },
  );

  /** Eigen selfbillingfacturen (alleen definitief). */
  app.get("/partner/selfbilling", { preValidation: portal }, async (req) => listSelfBilling(db, { partnerId: await partnerId(req), onlyFinal: true }));
  app.get("/partner/selfbilling/:id", { preValidation: portal, schema: { params: IdParams } }, async (req) => {
    const inv = await getSelfBillingInvoice(db, req.params.id);
    if (inv.partnerOrganizationId !== (await partnerId(req)) || inv.status === "draft") throw notFound("Factuur");
    return publicView(inv);
  });
  /** Akkoord of niet akkoord vanuit het portaal; vastgelegd met de ingelogde gebruiker. */
  app.post("/partner/selfbilling/:id/decision", { preValidation: portal, schema: { params: IdParams, body: Decision } }, async (req) => {
    const inv = await getSelfBillingInvoice(db, req.params.id);
    if (inv.partnerOrganizationId !== (await partnerId(req)) || inv.status === "draft") throw notFound("Factuur");
    // Akkoord moet van de partner zelf komen; via "Inloggen als" alleen in testmodus (en dan gelogd).
    if (req.actor.impersonatorUserId && !(await getSetting(db, "test.mode"))) {
      throw forbidden("impersonation_not_allowed", "Akkoord moet door de partner zelf worden gegeven, niet via Inloggen als");
    }
    const done = await decideApproval(
      db,
      inv.id,
      req.body,
      { method: "portal", userId: req.actor.userId, impersonatorUserId: req.actor.impersonatorUserId ?? null, ip: req.ip, userAgent: req.headers["user-agent"] ?? null, requestId: req.id },
      { transport: emailTransport, baseUrl: config.APP_BASE_URL },
    );
    return publicView(done);
  });

  app.get("/partner/penalties", { preValidation: portal }, async (req) => listPenalties(db, { partnerId: await partnerId(req) }));

  /** Alle actieve regio's, met welke tot het werkgebied van deze partner horen. */
  app.get("/partner/regions", { preValidation: portal }, async (req) => {
    const mine = await getPartnerRegions(db, await partnerId(req));
    return (await listRegions(db))
      .filter((r) => r.isActive)
      .map((r) => ({ id: r.id, name: r.name, mapCode: r.mapCode, postalRanges: r.postalRanges, selected: mine.includes(r.id) }));
  });
  app.put("/partner/regions", { preValidation: portal, schema: { body: z.object({ regionIds: z.array(z.string().uuid()).max(200) }) } }, async (req) =>
    setPartnerRegions(db, req.actor, await partnerId(req), req.body.regionIds),
  );
  app.get(
    "/partner/availability",
    { preValidation: portal, schema: { querystring: z.object({ from: IsoDate, to: IsoDate }) } },
    async (req) => listAvailability(db, { ...req.query, partnerId: await partnerId(req) }),
  );
  app.put("/partner/availability", { preValidation: portal, schema: { body: z.object({ changes: BlockChanges }) } }, async (req) => {
    await setAvailability(db, req.actor, await partnerId(req), req.body.changes);
    return { ok: true };
  });

  /** Bestand bekijken: medewerkers met planningsrecht, of de partner van de bijbehorende afspraak. */
  app.get("/files/:id", { schema: { params: IdParams } }, async (req, reply) => {
    const f = await loadFile(db, req.params.id);
    if (!req.actor.permissions.has("planning.read")) {
      if (!req.actor.permissions.has("partner.portal") || f.ownerType !== "appointment") throw notFound("Bestand");
      await ownAppointment(req, f.ownerId);
    }
    reply
      .header("content-type", f.contentType)
      .header("cache-control", "private, max-age=3600")
      .header("content-disposition", `inline; filename="${f.filename}"`)
      .header("x-content-type-options", "nosniff");
    return f.data;
  });
};
