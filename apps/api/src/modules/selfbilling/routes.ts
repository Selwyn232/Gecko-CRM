import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import type { Config } from "../../config.js";
import type { EmailTransport } from "../email/transport.js";
import {
  addCorrection,
  createDraft,
  deleteDraft,
  exportSelfBillingCsv,
  finalizeSelfBilling,
  getSelfBillingInvoice,
  listSelfBilling,
  markSelfBillingPaid,
  openItems,
  removeLine,
  requestApproval,
  getByApprovalToken,
  decideByToken,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");

export const Decision = z.object({
  decision: z.enum(["approve", "dispute"]),
  name: z.string().trim().min(2, "Vul uw naam in").max(200),
  reason: z.string().trim().max(2000).nullish(),
}).refine((d) => d.decision === "approve" || (d.reason?.length ?? 0) >= 3, { message: "Geef aan wat er niet klopt", path: ["reason"] });

export const selfBillingRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const deps = { transport: emailTransport, baseUrl: config.APP_BASE_URL };
  const read = requirePermission("invoices.read");
  const manage = requirePermission("invoices.manage");

  app.get("/selfbilling/open", { preValidation: read }, async () => openItems(db));
  app.get("/selfbilling", { preValidation: read, schema: { querystring: z.object({ partnerId: z.string().uuid().optional() }) } }, async (req) =>
    listSelfBilling(db, req.query),
  );
  app.get("/selfbilling/export.csv", { preValidation: read, schema: { querystring: z.object({ from: IsoDate, to: IsoDate }) } }, async (req, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="selfbilling-${req.query.from}-${req.query.to}.csv"`);
    return `﻿${await exportSelfBillingCsv(db, req.query.from, req.query.to)}`;
  });
  app.get("/selfbilling/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => getSelfBillingInvoice(db, req.params.id));

  app.post("/selfbilling/drafts", { preValidation: manage, schema: { body: z.object({ partnerId: z.string().uuid() }) } }, async (req, reply) => {
    reply.code(201);
    return createDraft(db, req.actor, req.body.partnerId);
  });
  app.post(
    "/selfbilling/:id/corrections",
    {
      preValidation: manage,
      schema: { params: IdParams, body: z.object({ description: z.string().min(1).max(300), amountCents: z.number().int().refine((n) => n !== 0, "Bedrag mag niet 0 zijn"), withVat: z.boolean() }) },
    },
    async (req) => addCorrection(db, req.actor, req.params.id, req.body),
  );
  app.delete("/selfbilling/:id/lines/:lineId", { preValidation: manage, schema: { params: z.object({ id: z.string().uuid(), lineId: z.string().uuid() }) } }, async (req) =>
    removeLine(db, req.actor, req.params.id, req.params.lineId),
  );
  app.delete("/selfbilling/:id", { preValidation: manage, schema: { params: IdParams } }, async (req, reply) => {
    await deleteDraft(db, req.actor, req.params.id);
    reply.code(204);
  });
  app.post("/selfbilling/:id/finalize", { preValidation: manage, schema: { params: IdParams } }, async (req) => finalizeSelfBilling(db, deps, req.actor, req.params.id));
  /** Opnieuw ter akkoord sturen (nieuwe link), bv. na "niet akkoord" en overleg, of als de mail kwijt is. */
  app.post("/selfbilling/:id/request-approval", { preValidation: manage, schema: { params: IdParams } }, async (req) => requestApproval(db, deps, req.actor, req.params.id));

  // Akkoordpagina voor de ontvanger (zonder inloggen; persoonlijke link uit de e-mail).
  const Token = z.object({ token: z.string().min(20).max(100) });
  app.get("/public/selfbilling/:token", { config: { auth: "public", rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { params: Token } }, async (req) =>
    getByApprovalToken(db, req.params.token),
  );
  app.post(
    "/public/selfbilling/:token/decision",
    { config: { auth: "public", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { params: Token, body: Decision } },
    async (req) =>
      decideByToken(db, req.params.token, req.body, { method: "email_link", ip: req.ip, userAgent: req.headers["user-agent"] ?? null, requestId: req.id }, deps),
  );
  app.post("/selfbilling/:id/paid", { preValidation: manage, schema: { params: IdParams, body: z.object({ paidAt: IsoDate }) } }, async (req) =>
    markSelfBillingPaid(db, req.actor, req.params.id, req.body.paidAt),
  );
};
