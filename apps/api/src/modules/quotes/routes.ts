import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { listEmails } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { acceptByToken, requestCode, sendQuoteLink, viewByToken } from "./links.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { acceptanceMethod, quoteStatus } from "./schema.js";
import {
  acceptQuote,
  addLine,
  createQuote,
  getQuote,
  listQuotes,
  quotableProducts,
  redactCosts,
  rejectQuote,
  removeLine,
  reviseQuote,
  sendQuote,
  updateLine,
  updateQuote,
  type QuoteView,
} from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });

/** Kostprijs en marge alleen voor wie inkoopprijzen mag zien. */
const view = (req: FastifyRequest, q: QuoteView) => (req.actor.permissions.has("purchase_prices.read") ? q : redactCosts(q));

export const quoteRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (
  app,
  { db, config, emailTransport },
) => {
  const read = requirePermission("quotes.read");
  const manage = requirePermission("quotes.manage");

  app.get(
    "/quotes",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          status: z.enum(quoteStatus.enumValues).optional(),
          customerId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          search: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => listQuotes(db, req.query),
  );

  app.get(
    "/quotes/products",
    { preValidation: read, schema: { querystring: z.object({ salesChannelId: z.string().uuid(), productGroupId: z.string().uuid() }) } },
    async (req) => quotableProducts(db, req.query.salesChannelId, req.query.productGroupId),
  );

  app.get("/quotes/:id", { preValidation: read, schema: { params: IdParams } }, async (req) => view(req, await getQuote(db, req.params.id)));

  const QuoteBody = z.object({
    customerId: z.string().uuid(),
    propertyId: z.string().uuid(),
    productGroupId: z.string().uuid(),
    salesChannelId: z.string().uuid(),
    advisorId: z.string().uuid().nullish(),
    installationPartnerId: z.string().uuid().nullish(),
    customerNote: z.string().max(5000).nullish(),
    internalNote: z.string().max(5000).nullish(),
  });

  app.post("/quotes", { preValidation: manage, schema: { body: QuoteBody } }, async (req, reply) => {
    reply.code(201);
    return view(req, await createQuote(db, req.actor, req.body));
  });
  app.patch(
    "/quotes/:id",
    { preValidation: manage, schema: { params: IdParams, body: QuoteBody.omit({ customerId: true, productGroupId: true }).partial() } },
    async (req) => view(req, await updateQuote(db, req.actor, req.params.id, req.body)),
  );

  app.post(
    "/quotes/:id/lines",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({ productId: z.string().uuid(), quantity: z.number().positive().max(100_000), description: z.string().max(500).nullish() }),
      },
    },
    async (req) => view(req, await addLine(db, req.actor, req.params.id, req.body)),
  );
  app.patch(
    "/quote-lines/:id",
    {
      preValidation: manage,
      schema: { params: IdParams, body: z.object({ quantity: z.number().positive().max(100_000).optional(), description: z.string().min(1).max(500).optional() }) },
    },
    async (req) => view(req, await updateLine(db, req.actor, req.params.id, req.body)),
  );
  app.delete("/quote-lines/:id", { preValidation: manage, schema: { params: IdParams } }, async (req) =>
    view(req, await removeLine(db, req.actor, req.params.id)),
  );

  app.post("/quotes/:id/send", { preValidation: manage, schema: { params: IdParams } }, async (req) => view(req, await sendQuote(db, req.actor, req.params.id)));
  app.post(
    "/quotes/:id/accept",
    {
      preValidation: manage,
      schema: {
        params: IdParams,
        body: z.object({
          acceptedByName: z.string().min(1).max(200),
          method: z.enum(acceptanceMethod.enumValues),
          acceptedAt: z.coerce.date().optional(),
        }),
      },
    },
    async (req) => view(req, await acceptQuote(db, req.actor, req.params.id, req.body)),
  );
  app.post(
    "/quotes/:id/reject",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ reason: z.string().max(2000).nullish() }) } },
    async (req) => view(req, await rejectQuote(db, req.actor, req.params.id, req.body.reason ?? null)),
  );
  app.post("/quotes/:id/revise", { preValidation: manage, schema: { params: IdParams } }, async (req) => view(req, await reviseQuote(db, req.actor, req.params.id)));

  // ------------------------------------------------------------ Akkoord via e-maillink
  app.post(
    "/quotes/:id/send-link",
    { preValidation: manage, schema: { params: IdParams, body: z.object({ email: z.string().email().nullish() }) } },
    async (req) => sendQuoteLink(db, emailTransport, config, req.actor, req.params.id, req.body),
  );
  app.get("/quotes/:id/emails", { preValidation: read, schema: { params: IdParams } }, async (req) =>
    (await listEmails(db, { relatedType: "quote", relatedId: req.params.id })).map(({ html: _h, ...rest }) => rest),
  );

  /** Openbare routes voor de klant (zonder login), beveiligd met het persoonlijke token. */
  const Token = z.object({ token: z.string().min(20).max(100) });
  app.get(
    "/public/quotes/:token",
    { config: { auth: "public", rateLimit: { max: 60, timeWindow: "1 minute" } }, schema: { params: Token } },
    async (req) => viewByToken(db, req.params.token),
  );
  app.post(
    "/public/quotes/:token/code",
    { config: { auth: "public", rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { params: Token } },
    async (req) => requestCode(db, emailTransport, req.params.token),
  );
  app.post(
    "/public/quotes/:token/accept",
    {
      config: { auth: "public", rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: Token,
        body: z.object({ code: z.string().min(4).max(10), name: z.string().min(2).max(200), agreeTerms: z.boolean() }),
      },
    },
    async (req) =>
      acceptByToken(db, emailTransport, req.params.token, req.body, { ip: req.ip, userAgent: req.headers["user-agent"], requestId: req.id }),
  );
};
