import { and, desc, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { users } from "../auth/schema.js";
import { productGroups, salesChannelProductGroups, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { createCustomer, formatCustomerNumber } from "../customers/service.js";
import type { EmailTransport } from "../email/transport.js";
import { journeyStatuses } from "../journeys/schema.js";
import { advisors, organizations } from "../organizations/schema.js";
import { projects } from "../projects/schema.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { sendQuoteLink } from "../quotes/links.js";
import { addLine, calculateTotals, createQuote, formatQuoteNumber, getQuote, quotableProducts, redactCosts, removeLine, sendQuote } from "../quotes/service.js";
import { getSelfBillingInvoice, listSelfBilling, openItems, publicView } from "../selfbilling/service.js";

const IdParams = z.object({ id: z.string().uuid() });
const NONE = "00000000-0000-0000-0000-000000000000";

/**
 * Verkooppartnerportaal (bv. Greenteam-adviseurs). Alles is afgeschermd op de eigen organisatie en de eigen
 * verkoopkanalen; een gebruiker die aan één adviseur is gekoppeld ziet alleen de eigen offertes en klanten.
 * Nooit kostprijzen of marges.
 */
export const salesRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const portal = requirePermission("sales.portal");

  async function scope(req: FastifyRequest) {
    const orgId = req.actor.organizationId;
    const [org] = orgId ? await db.select().from(organizations).where(eq(organizations.id, orgId)) : [];
    if (!org || org.type !== "sales_partner" || !org.isActive) throw forbidden("not_sales_partner", "Alleen voor verkooppartners");
    const channels = await db.select().from(salesChannels).where(and(eq(salesChannels.salesPartnerOrganizationId, org.id), eq(salesChannels.isActive, true)));
    const [u] = await db.select({ advisorId: users.advisorId }).from(users).where(eq(users.id, req.actor.userId!));
    return { org, channels, channelIds: channels.map((c) => c.id), advisorId: u?.advisorId ?? null, userId: req.actor.userId! };
  }
  type Scope = Awaited<ReturnType<typeof scope>>;

  const quoteScope = (s: Scope): SQL => {
    const parts: SQL[] = [inArray(quotes.salesChannelId, s.channelIds.length ? s.channelIds : [NONE])];
    if (s.advisorId) parts.push(eq(quotes.advisorId, s.advisorId));
    return and(...parts)!;
  };
  /** Eigen klanten: kanaal van de partner; adviseur alleen klanten die hij aanmaakte of een offerte voor heeft. */
  const customerScope = (s: Scope): SQL => {
    const inChannel = inArray(customers.salesChannelId, s.channelIds.length ? s.channelIds : [NONE]);
    if (!s.advisorId) return or(inChannel, exists(db.select({ x: sql`1` }).from(quotes).where(and(eq(quotes.customerId, customers.id), quoteScope(s)))))!;
    return or(and(inChannel, eq(customers.createdBy, s.userId)), exists(db.select({ x: sql`1` }).from(quotes).where(and(eq(quotes.customerId, customers.id), quoteScope(s)))))!;
  };
  async function ownQuote(s: Scope, id: string) {
    const [q] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.id, id), quoteScope(s)));
    if (!q) throw notFound("Offerte");
    return q.id;
  }
  async function ownCustomer(s: Scope, id: string) {
    const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, id), customerScope(s)));
    if (!c) throw notFound("Klant");
    return c.id;
  }
  /** Offerteweergave voor de partner: zonder kostprijs, marge, interne notitie en installateur. */
  const view = async (id: string) => {
    const q = redactCosts(await getQuote(db, id));
    const [p] = q.projectId
      ? await db.select({ status: journeyStatuses.name, phase: journeyStatuses.phase }).from(projects).innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId)).where(eq(projects.id, q.projectId))
      : [];
    return { ...q, internalNote: null, installationPartnerId: null, feeBasisPoints: undefined, acceptanceEvidence: null, projectStatus: p ?? null };
  };

  app.get("/sales/me", { preValidation: portal }, async (req) => {
    const s = await scope(req);
    const groups = s.channelIds.length
      ? await db
          .select({ channelId: salesChannelProductGroups.salesChannelId, id: productGroups.id, name: productGroups.name, fee: salesChannelProductGroups.feeBasisPoints })
          .from(salesChannelProductGroups)
          .innerJoin(productGroups, eq(productGroups.id, salesChannelProductGroups.productGroupId))
          .where(and(inArray(salesChannelProductGroups.salesChannelId, s.channelIds), eq(productGroups.isActive, true)))
      : [];
    const advs = await db.select().from(advisors).where(and(eq(advisors.organizationId, s.org.id), eq(advisors.isActive, true)));
    return {
      organization: { id: s.org.id, name: s.org.name },
      advisorId: s.advisorId,
      advisors: advs.filter((a) => !s.advisorId || a.id === s.advisorId).map((a) => ({ id: a.id, name: a.name })),
      channels: s.channels.map((c) => ({ id: c.id, name: c.name, feeBasisPoints: c.feeBasisPoints, productGroups: groups.filter((g) => g.channelId === c.id).map((g) => ({ id: g.id, name: g.name, feeBasisPoints: g.fee ?? c.feeBasisPoints })) })),
    };
  });

  app.get("/sales/catalog", { preValidation: portal, schema: { querystring: z.object({ channelId: z.string().uuid(), productGroupId: z.string().uuid() }) } }, async (req) => {
    const s = await scope(req);
    if (!s.channelIds.includes(req.query.channelId)) throw notFound("Verkoopkanaal");
    return quotableProducts(db, req.query.channelId, req.query.productGroupId);
  });

  app.get("/sales/customers", { preValidation: portal, schema: { querystring: z.object({ q: z.string().max(100).optional() }) } }, async (req) => {
    const s = await scope(req);
    const filters: SQL[] = [customerScope(s)];
    if (req.query.q?.trim()) {
      const like = `%${req.query.q.trim()}%`;
      filters.push(sql`((coalesce(${customers.firstName}, '') || ' ' || ${customers.lastName}) ILIKE ${like} OR ${customers.email} ILIKE ${like})`);
    }
    const rows = await db.select().from(customers).where(and(...filters)).orderBy(desc(customers.createdAt)).limit(100);
    const props = rows.length ? await db.select().from(properties).where(inArray(properties.customerId, rows.map((r) => r.id))) : [];
    return rows.map((c) => ({
      id: c.id,
      displayNumber: formatCustomerNumber(c.number),
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      properties: props.filter((p) => p.customerId === c.id),
    }));
  });

  app.post(
    "/sales/customers",
    {
      preValidation: portal,
      schema: {
        body: z.object({
          firstName: z.string().max(100).nullish(),
          lastName: z.string().min(1).max(100),
          email: z.string().email().nullish(),
          phone: z.string().max(30).nullish(),
          salesChannelId: z.string().uuid(),
          property: z.object({ street: z.string().min(1).max(200), houseNumber: z.string().min(1).max(20), houseNumberAddition: z.string().max(20).nullish(), postalCode: z.string().min(4).max(10), city: z.string().min(1).max(100) }),
        }),
      },
    },
    async (req, reply) => {
      const s = await scope(req);
      if (!s.channelIds.includes(req.body.salesChannelId)) throw badRequest("invalid_channel", "Onbekend verkoopkanaal");
      reply.code(201);
      return createCustomer(db, req.actor, req.body);
    },
  );

  app.get("/sales/quotes", { preValidation: portal }, async (req) => {
    const s = await scope(req);
    const rows = await db
      .select({ q: quotes, c: customers, advisor: advisors.name, status: journeyStatuses.name })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .leftJoin(advisors, eq(advisors.id, quotes.advisorId))
      .leftJoin(projects, eq(projects.id, quotes.projectId))
      .leftJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
      .where(quoteScope(s))
      .orderBy(desc(quotes.createdAt))
      .limit(300);
    const lines = rows.length ? await db.select().from(quoteLines).where(inArray(quoteLines.quoteId, rows.map((r) => r.q.id))) : [];
    return rows.map(({ q, c, advisor, status }) => ({
      id: q.id,
      displayNumber: formatQuoteNumber(q.number),
      kind: q.kind,
      status: q.status === "sent" && q.validUntil && q.validUntil < new Date().toISOString().slice(0, 10) ? "expired" : q.status,
      customer: { id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") },
      advisor,
      validUntil: q.validUntil,
      acceptedAt: q.acceptedAt,
      projectStatus: status,
      totals: calculateTotals(lines.filter((l) => l.quoteId === q.id)),
    }));
  });

  app.get("/sales/quotes/:id", { preValidation: portal, schema: { params: IdParams } }, async (req) => view(await ownQuote(await scope(req), req.params.id)));

  app.post(
    "/sales/quotes",
    {
      preValidation: portal,
      schema: {
        body: z.object({
          customerId: z.string().uuid(),
          propertyId: z.string().uuid(),
          productGroupId: z.string().uuid(),
          salesChannelId: z.string().uuid(),
          advisorId: z.string().uuid().nullish(),
          customerNote: z.string().max(2000).nullish(),
        }),
      },
    },
    async (req, reply) => {
      const s = await scope(req);
      if (!s.channelIds.includes(req.body.salesChannelId)) throw badRequest("invalid_channel", "Onbekend verkoopkanaal");
      await ownCustomer(s, req.body.customerId);
      // Een adviseur-gebruiker maakt altijd offertes op eigen naam.
      const advisorId = s.advisorId ?? req.body.advisorId ?? null;
      const q = await createQuote(db, req.actor, { ...req.body, advisorId, installationPartnerId: null, internalNote: null });
      reply.code(201);
      return view(q.id);
    },
  );
  app.post(
    "/sales/quotes/:id/lines",
    { preValidation: portal, schema: { params: IdParams, body: z.object({ productId: z.string().uuid(), quantity: z.number().positive().max(10_000) }) } },
    async (req) => {
      const id = await ownQuote(await scope(req), req.params.id);
      await addLine(db, req.actor, id, req.body);
      return view(id);
    },
  );
  app.delete("/sales/quotes/:id/lines/:lineId", { preValidation: portal, schema: { params: z.object({ id: z.string().uuid(), lineId: z.string().uuid() }) } }, async (req) => {
    const id = await ownQuote(await scope(req), req.params.id);
    const [l] = await db.select({ quoteId: quoteLines.quoteId }).from(quoteLines).where(eq(quoteLines.id, req.params.lineId));
    if (l?.quoteId !== id) throw notFound("Regel");
    await removeLine(db, req.actor, req.params.lineId);
    return view(id);
  });
  /** Definitief maken en de akkoordlink naar de klant mailen (in één stap). */
  app.post("/sales/quotes/:id/send", { preValidation: portal, schema: { params: IdParams } }, async (req) => {
    const id = await ownQuote(await scope(req), req.params.id);
    const [q] = await db.select().from(quotes).where(eq(quotes.id, id));
    if (q!.status === "draft") await sendQuote(db, req.actor, id);
    const link = await sendQuoteLink(db, emailTransport, config, req.actor, id, {});
    return { ...(await view(id)), emailStatus: link.emailStatus, sentTo: link.email };
  });

  /** Eigen fee: nog uit te betalen posten en selfbillingfacturen. */
  app.get("/sales/fees", { preValidation: portal }, async (req) => {
    const s = await scope(req);
    const [open] = await openItems(db, s.org.id);
    const advisorName = s.advisorId ? (await db.select({ n: advisors.name }).from(advisors).where(eq(advisors.id, s.advisorId)))[0]?.n : null;
    const items = (open?.items ?? []).filter((i) => !s.advisorId || i.advisorName === advisorName);
    const invoices = s.advisorId ? [] : await listSelfBilling(db, { partnerId: s.org.id, onlyFinal: true });
    return { open: items.map((i) => ({ description: i.description, advisorName: i.advisorName, basisCents: i.basisCents, feeBasisPoints: i.feeBasisPoints, amountCents: i.amountCents, missing: i.missing })), invoices };
  });
  app.get("/sales/fees/:id", { preValidation: portal, schema: { params: IdParams } }, async (req) => {
    const s = await scope(req);
    if (s.advisorId) throw notFound("Factuur");
    const inv = await getSelfBillingInvoice(db, req.params.id);
    if (inv.partnerOrganizationId !== s.org.id || inv.status === "draft") throw notFound("Factuur");
    return publicView(inv);
  });
};


