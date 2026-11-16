import { and, asc, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { multiplyCents } from "../../lib/money.js";
import { recordAudit } from "../audit/service.js";
import { effectivePrice } from "../catalog/prices.js";
import { productGroups, products, salesChannelProductGroups, salesChannels } from "../catalog/schema.js";
import { effectiveVatRate, unitCost } from "../catalog/service.js";
import { customers, properties } from "../customers/schema.js";
import { formatCustomerNumber } from "../customers/service.js";
import { emitEvent } from "../events/service.js";
import { advisors, organizations } from "../organizations/schema.js";
import { createProjectInTx } from "../projects/service.js";
import { quoteLines, quotes, type Quote, type QuoteLine } from "./schema.js";

export const formatQuoteNumber = (n: number) => `O-${String(n).padStart(6, "0")}`;

/** Producttypen die op een offerte aan de klant mogen staan. Componenten en arbeid zitten in het pakket. */
const QUOTABLE_TYPES = new Set(["package", "extra_work", "service"]);

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- Berekeningen

export interface QuoteTotals {
  subtotalCents: number;
  vat: { rateBasisPoints: number; baseCents: number; vatCents: number }[];
  vatCents: number;
  totalCents: number;
}

export interface QuoteMargin {
  costCents: number | null;
  feeCents: number | null;
  marginCents: number | null;
  marginBasisPoints: number | null;
  complete: boolean;
}

/** Btw wordt per tarief over het totaal berekend (niet per regel afgerond), zoals op de factuur. */
export function calculateTotals(lines: Pick<QuoteLine, "quantity" | "unitPriceCents" | "vatRateBasisPoints">[]): QuoteTotals {
  const byRate = new Map<number, number>();
  for (const l of lines) {
    byRate.set(l.vatRateBasisPoints, (byRate.get(l.vatRateBasisPoints) ?? 0) + multiplyCents(l.unitPriceCents, l.quantity));
  }
  const vat = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rateBasisPoints, baseCents]) => ({ rateBasisPoints, baseCents, vatCents: Math.round((baseCents * rateBasisPoints) / 10000) }));
  const subtotalCents = vat.reduce((s, v) => s + v.baseCents, 0);
  const vatCents = vat.reduce((s, v) => s + v.vatCents, 0);
  return { subtotalCents, vat, vatCents, totalCents: subtotalCents + vatCents };
}

/** Marge = omzet ex btw − kostprijs − fee verkoopkanaal. Onbekende kosten maken de marge onbekend. */
export function calculateMargin(
  lines: Pick<QuoteLine, "quantity" | "unitPriceCents" | "unitCostCents">[],
  feeBasisPoints: number | null,
): QuoteMargin {
  const revenue = lines.reduce((s, l) => s + multiplyCents(l.unitPriceCents, l.quantity), 0);
  const complete = lines.length > 0 && lines.every((l) => l.unitCostCents !== null);
  const costCents = complete ? lines.reduce((s, l) => s + multiplyCents(l.unitCostCents!, l.quantity), 0) : null;
  const feeCents = feeBasisPoints === null ? null : Math.round((revenue * feeBasisPoints) / 10000);
  const marginCents = costCents === null ? null : revenue - costCents - (feeCents ?? 0);
  return {
    costCents,
    feeCents,
    marginCents,
    marginBasisPoints: marginCents === null || revenue === 0 ? null : Math.round((marginCents * 10000) / revenue),
    complete,
  };
}

/** Haalt prijs, btw en kostprijs op voor een product op een offerte. */
async function priceLine(tx: DbOrTx, quote: Quote, productId: string, date: string) {
  const [product] = await tx.select().from(products).where(eq(products.id, productId));
  if (!product) throw badRequest("unknown_product", "Product bestaat niet");
  if (product.productGroupId !== quote.productGroupId) throw badRequest("wrong_product_group", "Product hoort niet bij de productgroep van deze offerte");
  if (!QUOTABLE_TYPES.has(product.type)) throw badRequest("not_quotable", "Alleen pakketten, meerwerk en diensten kunnen op een offerte");
  if (!product.isActive) throw badRequest("inactive_product", `Product ${product.code} is niet actief`);
  const price = await effectivePrice(tx, "sales", productId, quote.salesChannelId, date);
  if (!price) throw badRequest("no_sales_price", `Geen verkoopprijs voor ${product.code} in dit kanaal op ${date}`);
  const vat = await effectiveVatRate(tx, product.vatCode, date);
  if (vat === null) throw badRequest("no_vat_rate", `Geen btw-tarief voor code ${product.vatCode}`);
  return {
    product,
    unitPriceCents: price.priceCents,
    vatRateBasisPoints: vat,
    unitCostCents: await unitCost(tx, productId, date, quote.installationPartnerId),
  };
}

// ---------------------------------------------------------------- Lezen

const effectiveStatus = (q: Quote) => (q.status === "sent" && q.validUntil && q.validUntil < todayIso() ? "expired" : q.status);

export async function getQuote(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ quote: quotes, customer: customers, property: properties, channel: salesChannels, group: productGroups, advisor: advisors })
    .from(quotes)
    .innerJoin(customers, eq(customers.id, quotes.customerId))
    .innerJoin(properties, eq(properties.id, quotes.propertyId))
    .innerJoin(salesChannels, eq(salesChannels.id, quotes.salesChannelId))
    .innerJoin(productGroups, eq(productGroups.id, quotes.productGroupId))
    .leftJoin(advisors, eq(advisors.id, quotes.advisorId))
    .where(eq(quotes.id, id));
  if (!row) throw notFound("Offerte");
  const lines = await db
    .select({ line: quoteLines, code: products.code, unit: products.unit, type: products.type })
    .from(quoteLines)
    .innerJoin(products, eq(products.id, quoteLines.productId))
    .where(eq(quoteLines.quoteId, id))
    .orderBy(asc(quoteLines.sortOrder), asc(quoteLines.createdAt));
  const plain = lines.map((l) => l.line);
  const feeBp = row.quote.status === "draft" ? row.channel.feeBasisPoints : row.quote.feeBasisPoints;
  return {
    ...row.quote,
    displayNumber: formatQuoteNumber(row.quote.number),
    effectiveStatus: effectiveStatus(row.quote),
    customer: { ...row.customer, displayNumber: formatCustomerNumber(row.customer.number) },
    property: row.property,
    salesChannel: row.channel,
    productGroup: row.group,
    advisor: row.advisor,
    lines: lines.map((l) => ({ ...l.line, productCode: l.code, unit: l.unit, productType: l.type, lineTotalCents: multiplyCents(l.line.unitPriceCents, l.line.quantity) })),
    totals: calculateTotals(plain),
    margin: calculateMargin(plain, feeBp ?? null),
  };
}

export type QuoteView = Awaited<ReturnType<typeof getQuote>>;

/** Verwijdert kostprijs en marge uit een offerte voor wie geen inkoopprijzen mag zien. */
export function redactCosts(q: QuoteView) {
  return { ...q, margin: null, lines: q.lines.map((l) => ({ ...l, unitCostCents: null })) };
}

export async function listQuotes(
  db: DbOrTx,
  q: { status?: Quote["status"]; customerId?: string; projectId?: string; search?: string; limit: number; offset: number },
) {
  const filters: SQL[] = [];
  if (q.status) filters.push(eq(quotes.status, q.status));
  if (q.customerId) filters.push(eq(quotes.customerId, q.customerId));
  if (q.projectId) filters.push(eq(quotes.projectId, q.projectId));
  if (q.search) {
    const like = `%${q.search.trim()}%`;
    const num = q.search.trim().replace(/^[ok]-?/i, "");
    const parts: SQL[] = [ilike(customers.lastName, like), ilike(customers.firstName, like), ilike(properties.postalCode, `%${q.search.replace(/\s/g, "")}%`)];
    if (/^\d+$/.test(num)) parts.push(eq(quotes.number, Number(num)));
    filters.push(or(...parts)!);
  }
  const rows = await db
    .select({ quote: quotes, customer: customers, property: properties })
    .from(quotes)
    .innerJoin(customers, eq(customers.id, quotes.customerId))
    .innerJoin(properties, eq(properties.id, quotes.propertyId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(quotes.createdAt))
    .limit(q.limit)
    .offset(q.offset);
  const ids = rows.map((r) => r.quote.id);
  const lines = ids.length ? await db.select().from(quoteLines).where(inArray(quoteLines.quoteId, ids)) : [];
  return rows.map((r) => ({
    ...r.quote,
    displayNumber: formatQuoteNumber(r.quote.number),
    effectiveStatus: effectiveStatus(r.quote),
    customer: { id: r.customer.id, firstName: r.customer.firstName, lastName: r.customer.lastName, displayNumber: formatCustomerNumber(r.customer.number) },
    property: r.property,
    totals: calculateTotals(lines.filter((l) => l.quoteId === r.quote.id)),
  }));
}

// ---------------------------------------------------------------- Concept

export interface QuoteInput {
  customerId: string;
  propertyId: string;
  productGroupId: string;
  salesChannelId: string;
  advisorId?: string | null;
  installationPartnerId?: string | null;
  customerNote?: string | null;
  internalNote?: string | null;
}

async function assertQuoteRefs(tx: DbOrTx, input: Partial<QuoteInput>, existing?: Quote) {
  const merged = { ...existing, ...input } as QuoteInput;
  const [prop] = await tx.select().from(properties).where(eq(properties.id, merged.propertyId));
  if (!prop || prop.customerId !== merged.customerId) throw badRequest("invalid_property", "Woning hoort niet bij deze klant");
  const [allowed] = await tx
    .select()
    .from(salesChannelProductGroups)
    .where(and(eq(salesChannelProductGroups.salesChannelId, merged.salesChannelId), eq(salesChannelProductGroups.productGroupId, merged.productGroupId)));
  if (!allowed) throw badRequest("product_group_not_in_channel", "Dit verkoopkanaal verkoopt deze productgroep niet");
  if (merged.advisorId) {
    const [ch] = await tx.select().from(salesChannels).where(eq(salesChannels.id, merged.salesChannelId));
    const [adv] = await tx.select().from(advisors).where(eq(advisors.id, merged.advisorId));
    if (!adv || adv.organizationId !== ch?.salesPartnerOrganizationId) throw badRequest("invalid_advisor", "Adviseur hoort niet bij de verkooppartner van dit kanaal");
  }
  if (merged.installationPartnerId) {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, merged.installationPartnerId));
    if (!org || org.type !== "installation_partner") throw badRequest("invalid_partner", "Organisatie is geen installatiepartner");
  }
}

async function loadDraft(tx: DbOrTx, id: string) {
  const [q] = await tx.select().from(quotes).where(eq(quotes.id, id)).for("update");
  if (!q) throw notFound("Offerte");
  if (q.status !== "draft") throw conflict("quote_not_draft", "Alleen een concept-offerte kan worden gewijzigd; maak een nieuwe versie");
  return q;
}

export async function createQuote(db: Db, actor: ActorContext, input: QuoteInput) {
  return db.transaction(async (tx) => {
    await assertQuoteRefs(tx, input);
    const [q] = await tx.insert(quotes).values({ ...input, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, { action: "quote.created", entityType: "quote", entityId: q!.id, after: q });
    return getQuote(tx, q!.id);
  });
}

export async function updateQuote(db: Db, actor: ActorContext, id: string, input: Partial<Omit<QuoteInput, "customerId" | "productGroupId">>) {
  return db.transaction(async (tx) => {
    const before = await loadDraft(tx, id);
    await assertQuoteRefs(tx, input, before);
    const [after] = await tx.update(quotes).set(input).where(eq(quotes.id, id)).returning();
    // Ander kanaal of andere partner → prijzen en kosten opnieuw bepalen.
    if (input.salesChannelId !== undefined || input.installationPartnerId !== undefined) await repriceLines(tx, after!, todayIso());
    await recordAudit(tx, actor, { action: "quote.updated", entityType: "quote", entityId: id, before, after });
    return getQuote(tx, id);
  });
}

async function repriceLines(tx: DbOrTx, quote: Quote, date: string) {
  const lines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id));
  for (const l of lines) {
    const p = await priceLine(tx, quote, l.productId, date);
    await tx
      .update(quoteLines)
      .set({ unitPriceCents: p.unitPriceCents, vatRateBasisPoints: p.vatRateBasisPoints, unitCostCents: p.unitCostCents })
      .where(eq(quoteLines.id, l.id));
  }
}

export async function addLine(db: Db, actor: ActorContext, quoteId: string, input: { productId: string; quantity: number; description?: string | null }) {
  return db.transaction(async (tx) => {
    const q = await loadDraft(tx, quoteId);
    const p = await priceLine(tx, q, input.productId, todayIso());
    const existing = await tx.select({ id: quoteLines.id }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    const [line] = await tx
      .insert(quoteLines)
      .values({
        quoteId,
        productId: input.productId,
        description: input.description?.trim() || p.product.name,
        quantity: String(input.quantity),
        unitPriceCents: p.unitPriceCents,
        vatRateBasisPoints: p.vatRateBasisPoints,
        unitCostCents: p.unitCostCents,
        sortOrder: (existing.length + 1) * 10,
      })
      .returning();
    await recordAudit(tx, actor, { action: "quote.line_added", entityType: "quote", entityId: quoteId, after: { code: p.product.code, quantity: line!.quantity } });
    return getQuote(tx, quoteId);
  });
}

export async function updateLine(db: Db, actor: ActorContext, lineId: string, input: { quantity?: number; description?: string }) {
  return db.transaction(async (tx) => {
    const [line] = await tx.select().from(quoteLines).where(eq(quoteLines.id, lineId));
    if (!line) throw notFound("Offerteregel");
    await loadDraft(tx, line.quoteId);
    const patch: Partial<QuoteLine> = {};
    if (input.quantity !== undefined) patch.quantity = String(input.quantity);
    if (input.description !== undefined) patch.description = input.description.trim();
    const [after] = await tx.update(quoteLines).set(patch).where(eq(quoteLines.id, lineId)).returning();
    await recordAudit(tx, actor, {
      action: "quote.line_updated",
      entityType: "quote",
      entityId: line.quoteId,
      before: { description: line.description, quantity: line.quantity },
      after: { description: after!.description, quantity: after!.quantity },
    });
    return getQuote(tx, line.quoteId);
  });
}

export async function removeLine(db: Db, actor: ActorContext, lineId: string) {
  return db.transaction(async (tx) => {
    const [line] = await tx.select().from(quoteLines).where(eq(quoteLines.id, lineId));
    if (!line) throw notFound("Offerteregel");
    await loadDraft(tx, line.quoteId);
    await tx.delete(quoteLines).where(eq(quoteLines.id, lineId));
    await recordAudit(tx, actor, { action: "quote.line_removed", entityType: "quote", entityId: line.quoteId, before: { description: line.description, quantity: line.quantity } });
    return getQuote(tx, line.quoteId);
  });
}

// ---------------------------------------------------------------- Levenscyclus

/** Versturen: prijzen, btw, kosten en fee worden op vandaag vastgezet; geldigheid start. */
export async function sendQuote(db: Db, actor: ActorContext, id: string) {
  return db.transaction(async (tx) => {
    const q = await loadDraft(tx, id);
    const lines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteId, id));
    if (!lines.length) throw badRequest("quote_empty", "Een offerte zonder regels kan niet worden verstuurd");
    if (!lines.some((l) => l.unitPriceCents > 0)) throw badRequest("quote_zero", "Offerte heeft geen bedrag");
    const today = todayIso();
    await repriceLines(tx, q, today);
    const [ch] = await tx.select().from(salesChannels).where(eq(salesChannels.id, q.salesChannelId));
    const [after] = await tx
      .update(quotes)
      .set({ status: "sent", sentAt: new Date(), priceDate: today, validUntil: addDays(today, ch!.quoteValidityDays), feeBasisPoints: ch!.feeBasisPoints })
      .where(eq(quotes.id, id))
      .returning();
    await recordAudit(tx, actor, { action: "quote.sent", entityType: "quote", entityId: id, before: { status: q.status }, after: { status: after!.status, validUntil: after!.validUntil } });
    await emitEvent(tx, "quote.sent", { type: "quote", id }, { quoteId: id, customerId: q.customerId });
    return getQuote(tx, id);
  });
}

async function loadSent(tx: DbOrTx, id: string) {
  const [q] = await tx.select().from(quotes).where(eq(quotes.id, id)).for("update");
  if (!q) throw notFound("Offerte");
  if (q.status !== "sent") throw conflict("quote_not_sent", "Alleen een verstuurde offerte kan worden geaccepteerd of afgewezen");
  return q;
}

/**
 * Klant gaat akkoord: het project wordt aangemaakt in de startstatus van de klantreis.
 * De offerte (met vastgezette prijzen en kostprijs) blijft de basis voor facturen en voorcalculatie.
 */
export async function acceptQuote(
  db: Db,
  actor: ActorContext,
  id: string,
  input: { acceptedByName: string; method: NonNullable<Quote["acceptanceMethod"]>; acceptedAt?: Date },
) {
  return db.transaction(async (tx) => {
    const q = await loadSent(tx, id);
    if (effectiveStatus(q) === "expired") throw conflict("quote_expired", "Offerte is verlopen; maak een nieuwe versie");
    const project = await createProjectInTx(tx, actor, {
      customerId: q.customerId,
      propertyId: q.propertyId,
      productGroupId: q.productGroupId,
      salesChannelId: q.salesChannelId,
      installationPartnerId: q.installationPartnerId,
    });
    await tx
      .update(quotes)
      .set({ status: "accepted", acceptedAt: input.acceptedAt ?? new Date(), acceptedByName: input.acceptedByName, acceptanceMethod: input.method, projectId: project.id })
      .where(eq(quotes.id, id));
    await recordAudit(tx, actor, {
      action: "quote.accepted",
      entityType: "quote",
      entityId: id,
      before: { status: "sent" },
      after: { status: "accepted", acceptedByName: input.acceptedByName, method: input.method, projectId: project.id },
    });
    await emitEvent(tx, "quote.accepted", { type: "quote", id }, { quoteId: id, projectId: project.id, customerId: q.customerId });
    return getQuote(tx, id);
  });
}

export async function rejectQuote(db: Db, actor: ActorContext, id: string, reason: string | null) {
  return db.transaction(async (tx) => {
    await loadSent(tx, id);
    await tx.update(quotes).set({ status: "rejected", rejectedAt: new Date(), rejectionReason: reason }).where(eq(quotes.id, id));
    await recordAudit(tx, actor, { action: "quote.rejected", entityType: "quote", entityId: id, after: { status: "rejected", reason } });
    await emitEvent(tx, "quote.rejected", { type: "quote", id }, { quoteId: id });
    return getQuote(tx, id);
  });
}

/** Nieuwe versie: kopie als concept met actuele prijzen; de oude offerte wordt "vervangen". */
export async function reviseQuote(db: Db, actor: ActorContext, id: string) {
  return db.transaction(async (tx) => {
    const [q] = await tx.select().from(quotes).where(eq(quotes.id, id)).for("update");
    if (!q) throw notFound("Offerte");
    if (q.status !== "sent" && q.status !== "rejected") {
      throw conflict("quote_not_revisable", "Alleen een verstuurde of afgewezen offerte kan een nieuwe versie krijgen");
    }
    const [copy] = await tx
      .insert(quotes)
      .values({
        customerId: q.customerId,
        propertyId: q.propertyId,
        productGroupId: q.productGroupId,
        salesChannelId: q.salesChannelId,
        advisorId: q.advisorId,
        installationPartnerId: q.installationPartnerId,
        customerNote: q.customerNote,
        internalNote: q.internalNote,
        supersedesQuoteId: q.id,
        createdBy: actor.userId,
      })
      .returning();
    const lines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteId, id));
    if (lines.length) {
      await tx.insert(quoteLines).values(
        lines.map((l) => ({
          quoteId: copy!.id,
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          vatRateBasisPoints: l.vatRateBasisPoints,
          unitCostCents: l.unitCostCents,
          sortOrder: l.sortOrder,
        })),
      );
      await repriceLines(tx, copy!, todayIso());
    }
    await tx.update(quotes).set({ status: "superseded" }).where(eq(quotes.id, id));
    await recordAudit(tx, actor, { action: "quote.revised", entityType: "quote", entityId: id, after: { newQuoteId: copy!.id } });
    await recordAudit(tx, actor, { action: "quote.created", entityType: "quote", entityId: copy!.id, after: { supersedesQuoteId: id } });
    return getQuote(tx, copy!.id);
  });
}

/** Producten die op een offerte voor dit kanaal en deze productgroep kunnen, met actuele prijs. */
export async function quotableProducts(db: DbOrTx, salesChannelId: string, productGroupId: string) {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.productGroupId, productGroupId), eq(products.isActive, true), inArray(products.type, ["package", "extra_work", "service"])))
    .orderBy(asc(products.code));
  const today = todayIso();
  const out = [];
  for (const p of rows) {
    const price = await effectivePrice(db, "sales", p.id, salesChannelId, today);
    if (price) out.push({ id: p.id, code: p.code, name: p.name, type: p.type, unit: p.unit, priceCents: price.priceCents });
  }
  return out;
}
