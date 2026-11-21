import { ownCustomersOnly } from "../specialists/service.js";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import { forbidden } from "../../lib/errors.js";
import { listEmails } from "../email/service.js";
import { getSetting } from "../settings/service.js";
import { runDunning } from "./dunning.js";
import { dunningEvents, invoiceStatus } from "./schema.js";
import {
  createInvoiceForProject,
  creditInvoice,
  exportCsv,
  getInvoice,
  handleProviderWebhook,
  listInvoices,
  publicInvoice,
  registerPayment,
  sendInvoice,
  setDunningPause,
  settlePayment,
  startOnlinePayment,
  testPaymentInfo,
  type BillingDeps,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");

export const invoiceRoutes: FastifyPluginAsyncZod<{ db: Db; deps: BillingDeps }> = async (app, { db, deps }) => {
  const read = requirePermission("invoices.read");
  const manage = requirePermission("invoices.manage");

  app.get(
    "/invoices",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          status: z.enum(invoiceStatus.enumValues).optional(),
          customerId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          overdue: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => listInvoices(db, req.query, req.actor),
  );

  app.get(
    "/invoices/export.csv",
    { preValidation: read, schema: { querystring: z.object({ from: IsoDate, to: IsoDate }) } },
    async (req, reply) => {
      if (ownCustomersOnly(req.actor)) throw forbidden("export_not_allowed", "Exporteren kan alleen met toegang tot alle klanten");
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="facturen-${req.query.from}-${req.query.to}.csv"`);
      return exportCsv(db, req.query.from, req.query.to);
    },
  );

  app.get("/invoices/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => {
    const inv = await getInvoice(db, req.params.id);
    const dunning = await db.select().from(dunningEvents).where(eq(dunningEvents.invoiceId, inv.id)).orderBy(desc(dunningEvents.createdAt));
    const emails = (await listEmails(db, { relatedType: "invoice", relatedId: inv.id })).map(({ html: _h, ...rest }) => rest);
    return { ...inv, dunning, emails };
  });

  /** Handmatig factureren (naast de automatische trigger in de klantreis). */
  app.post(
    "/projects/:id/invoices",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ type: z.enum(["deposit", "final"]), send: z.boolean().default(true) }) } },
    async (req) => {
      const { invoiceId, created } = await createInvoiceForProject(db, req.actor, req.params.id, req.body.type);
      const sent = created && req.body.send ? await sendInvoice(db, deps, req.actor, invoiceId) : null;
      return { invoiceId, created, sent };
    },
  );

  app.post("/invoices/:id/send", { preValidation: manage, schema: { params: IdParams } }, async (req) => sendInvoice(db, deps, req.actor, req.params.id));

  app.post(
    "/invoices/:id/payments",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({
          amountCents: z.number().int().positive(),
          method: z.enum(["bank_transfer", "warmtefonds", "other"]),
          paidAt: z.coerce.date().optional(),
          note: z.string().max(500).nullish(),
        }),
      },
    },
    async (req) => registerPayment(db, req.actor, req.params.id, req.body),
  );

  app.post(
    "/invoices/:id/credit",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ reason: z.string().min(3).max(500) }) } },
    async (req) => creditInvoice(db, req.actor, req.params.id, req.body.reason),
  );

  app.post(
    "/invoices/:id/dunning-pause",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ reason: z.string().max(500).nullable() }) } },
    async (req) => setDunningPause(db, req.actor, req.params.id, req.body.reason),
  );

  /** Aanmaanronde direct draaien (normaal elk uur automatisch). */
  app.post("/dunning/run", { preValidation: manage }, async () => runDunning(db, deps));

  // ------------------------------------------------------------ Openbaar (klant, zonder login)
  const Token = z.object({ token: z.string().min(20).max(100) });
  app.get("/public/invoices/:token", { config: { auth: "public", rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { params: Token } }, async (req) =>
    publicInvoice(db, deps, req.params.token),
  );
  app.post("/public/invoices/:token/pay", { config: { auth: "public", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { params: Token } }, async (req) =>
    startOnlinePayment(db, deps, req.params.token),
  );

  /** Mollie-webhook: bevat alleen een betaal-id; de status wordt altijd bij Mollie opgehaald. */
  app.post(
    "/public/payments/mollie/webhook",
    { config: { auth: "public", rateLimit: { max: 600, timeWindow: "1 minute" } }, schema: { body: z.object({ id: z.string().max(100) }) } },
    async (req, reply) => {
      if (deps.paymentProvider.name === "mollie") await handleProviderWebhook(db, deps, req.body.id);
      reply.code(200);
      return "";
    },
  );

  // Testmodus: gesimuleerde betaalpagina. Alleen beschikbaar zolang er geen echte provider is.
  const testOnly = async () => {
    if (deps.paymentProvider.name !== "test") throw forbidden("test_mode_off", "Testbetalingen zijn uitgeschakeld");
    // Live zonder Mollie: alleen als de testmodus aan staat (anders kan iedereen met een factuurlink "betalen").
    if (deps.config.NODE_ENV === "production" && !(await getSetting(db, "test.mode"))) throw forbidden("test_mode_off", "Testbetalingen zijn uitgeschakeld");
  };
  app.get(
    "/public/test-payments/:id",
    { config: { auth: "public" }, preValidation: testOnly, schema: { params: IdParams } },
    async (req) => testPaymentInfo(db, req.params.id),
  );
  app.post(
    "/public/test-payments/:id",
    { config: { auth: "public" }, preValidation: testOnly, schema: { params: IdParams, body: z.object({ result: z.enum(["paid", "failed", "canceled"]) }) } },
    async (req) => {
      await settlePayment(db, req.params.id, req.body.result, new Date());
      return testPaymentInfo(db, req.params.id);
    },
  );
};
