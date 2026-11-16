import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { randomToken, sha256 } from "../../lib/crypto.js";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { multiplyCents } from "../../lib/money.js";
import { recordAudit } from "../audit/service.js";
import { effectivePrice } from "../catalog/prices.js";
import { bomItems, productGroups, products, salesChannels } from "../catalog/schema.js";
import { calculateCost, effectiveVatRate } from "../catalog/service.js";
import { properties } from "../customers/schema.js";
import { button, escapeHtml, layout, type Company } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { invoices } from "../invoices/schema.js";
import { organizations } from "../organizations/schema.js";
import { partnerPenalties } from "../planning/schema.js";
import { projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { getCompany } from "../quotes/links.js";
import { getSetting } from "../settings/service.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { getQuote } from "../quotes/service.js";
import { selfBillingInvoices, selfBillingLines, selfBillingSequences, type SelfBillingInvoice } from "./schema.js";

export type VatMode = "normal" | "reverse_charge";
type LineKind = "fee" | "installation" | "extra_work";

export interface OpenItem {
  kind: LineKind;
  projectId: string;
  projectNumber: string;
  quoteId: string | null;
  advisorName: string | null;
  description: string;
  basisCents: number | null;
  feeBasisPoints: number | null;
  /** Null = kan nog niet worden uitbetaald (zie `missing`). */
  amountCents: number | null;
  missing: string | null;
}

const euro = (cents: number) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const dateNl = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL") : "—");

export const vatModeFor = (org: { type: string; selfBillingVatMode: string | null }): VatMode =>
  org.selfBillingVatMode === "normal" || org.selfBillingVatMode === "reverse_charge"
    ? org.selfBillingVatMode
    : org.type === "installation_partner"
      ? "reverse_charge"
      : "normal";

/** Project is voldoende betaald: aanbetaling (of eindfactuur) betaald, resp. eindfactuur betaald. */
const paid = (type: "deposit" | "final") =>
  sql`EXISTS (SELECT 1 FROM ${invoices} WHERE ${invoices.projectId} = ${projects.id} AND ${invoices.type} = ${type} AND ${invoices.status} = 'paid')`;
/** Geannuleerde projecten leveren (nog niet afgerekende) fee en installatie niet op; correcties gaan handmatig. */
const notCanceled = sql`NOT EXISTS (SELECT 1 FROM journey_statuses js WHERE js.id = ${projects.statusId} AND js.key = 'geannuleerd')`;
const alreadyBilled = (kind: LineKind, column: "quote_id" | "project_id", value: unknown) =>
  sql`NOT EXISTS (SELECT 1 FROM ${selfBillingLines} WHERE ${selfBillingLines.kind} = ${kind} AND ${sql.raw(`self_billing_lines.${column}`)} = ${value})`;

async function projectLabel(db: DbOrTx, projectId: string) {
  const [r] = await db
    .select({ number: projects.number, group: productGroups.name, street: properties.street, houseNumber: properties.houseNumber, addition: properties.houseNumberAddition, city: properties.city })
    .from(projects)
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .where(eq(projects.id, projectId));
  const number = formatProjectNumber(r!.number);
  return { number, label: `${number} · ${r!.group} · ${r!.street} ${r!.houseNumber}${r!.addition ? `-${r!.addition}` : ""}, ${r!.city}` };
}

/**
 * Wat de partner krijgt voor één offerteregel:
 * 1. een vast partnertarief op het product zelf (bv. per pakket), anders
 * 2. de arbeid in de stuklijst tegen partnertarief, anders
 * 3. bij arbeid/meerwerk zonder stuklijst: het partnertarief (ontbreekt het, dan melden).
 * Materiaal zonder arbeid levert de partner niets op.
 */
export async function partnerAmount(db: DbOrTx, productId: string, quantity: string, partnerId: string, date: string) {
  const direct = await effectivePrice(db, "partner", productId, partnerId, date);
  if (direct) return { cents: multiplyCents(direct.priceCents, quantity), missing: [] as string[] };
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  const [hasBom] = await db.select({ id: bomItems.id }).from(bomItems).where(eq(bomItems.parentProductId, productId)).limit(1);
  if (hasBom) {
    const cost = await calculateCost(db, productId, { date, partnerOrganizationId: partnerId });
    const labor = cost.lines.filter((l) => l.source === "partner");
    const missing = labor.filter((l) => l.totalCents === null).map((l) => l.code);
    return { cents: multiplyCents(labor.reduce((s, l) => s + (l.totalCents ?? 0), 0), quantity), missing };
  }
  if (product && (product.type === "labor" || product.type === "extra_work" || product.type === "service")) return { cents: 0, missing: [product.code] };
  return { cents: 0, missing: [] };
}

export async function quotePartnerAmount(db: DbOrTx, quoteId: string, partnerId: string, date: string) {
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
  let cents = 0;
  const missing: string[] = [];
  for (const l of lines) {
    const r = await partnerAmount(db, l.productId, l.quantity, partnerId, date);
    cents += r.cents;
    missing.push(...r.missing);
  }
  return { cents, missing: [...new Set(missing)] };
}

/** Alle nog uit te betalen posten, per partner. */
export async function openItems(db: DbOrTx, onlyPartnerId?: string) {
  const byPartner = new Map<string, OpenItem[]>();
  const add = (partnerId: string, item: OpenItem) => byPartner.set(partnerId, [...(byPartner.get(partnerId) ?? []), item]);

  // Fee verkooppartner: per geaccepteerde offerte (ook meerwerk), zodra de aanbetaling is betaald.
  const feeQuotes = await db
    .select({ id: quotes.id, projectId: quotes.projectId, feeBp: quotes.feeBasisPoints, channelFeeBp: salesChannels.feeBasisPoints, partnerId: salesChannels.salesPartnerOrganizationId })
    .from(quotes)
    .innerJoin(salesChannels, eq(salesChannels.id, quotes.salesChannelId))
    .innerJoin(projects, eq(projects.id, quotes.projectId))
    .where(and(eq(quotes.status, "accepted"), isNotNull(salesChannels.salesPartnerOrganizationId), sql`(${paid("deposit")} OR ${paid("final")})`, alreadyBilled("fee", "quote_id", quotes.id), notCanceled))
    .orderBy(asc(quotes.number));
  for (const q of feeQuotes) {
    if (onlyPartnerId && q.partnerId !== onlyPartnerId) continue;
    const view = await getQuote(db, q.id);
    const { number, label } = await projectLabel(db, q.projectId!);
    // Fee vastgezet bij versturen; was die toen nog niet ingesteld, dan geldt de huidige fee van het kanaal.
    const bp = q.feeBp ?? q.channelFeeBp;
    const basis = view.totals.subtotalCents;
    add(q.partnerId!, {
      kind: "fee",
      projectId: q.projectId!,
      projectNumber: number,
      quoteId: q.id,
      advisorName: view.advisor?.name ?? null,
      description: `${label} — ${view.kind === "extra_work" ? "meerwerk" : "offerte"} ${view.displayNumber}`,
      basisCents: basis,
      feeBasisPoints: bp,
      amountCents: bp === null ? null : Math.round((basis * bp) / 10_000),
      missing: bp === null ? "Fee-percentage van het verkoopkanaal is niet ingesteld (Verkoopkanalen)" : null,
    });
  }

  // Installatiepartner: na betaalde eindfactuur. Installatie (hoofdofferte) en elk geaccepteerd meerwerk.
  const finished = await db
    .select({ id: projects.id, partnerId: projects.installationPartnerId })
    .from(projects)
    .where(and(isNotNull(projects.installationPartnerId), paid("final"), notCanceled));
  for (const p of finished) {
    if (onlyPartnerId && p.partnerId !== onlyPartnerId) continue;
    const accepted = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.projectId, p.id), eq(quotes.status, "accepted")))
      .orderBy(asc(quotes.number));
    const { number, label } = await projectLabel(db, p.id);
    for (const q of accepted) {
      const kind: LineKind = q.kind === "main" ? "installation" : "extra_work";
      const done = await db
        .select({ id: selfBillingLines.id })
        .from(selfBillingLines)
        .where(kind === "installation" ? and(eq(selfBillingLines.kind, kind), eq(selfBillingLines.projectId, p.id)) : and(eq(selfBillingLines.kind, kind), eq(selfBillingLines.quoteId, q.id)));
      if (done.length) continue;
      const r = await quotePartnerAmount(db, q.id, p.partnerId!, q.priceDate ?? todayIso());
      add(p.partnerId!, {
        kind,
        projectId: p.id,
        projectNumber: number,
        quoteId: q.id,
        advisorName: null,
        description: `${label} — ${kind === "installation" ? "installatie" : `meerwerk ${(await getQuote(db, q.id)).displayNumber}`}`,
        basisCents: null,
        feeBasisPoints: null,
        amountCents: r.missing.length ? null : r.cents,
        missing: r.missing.length ? `Partnertarief ontbreekt voor ${r.missing.join(", ")} (Producten → partnertarieven)` : null,
      });
    }
  }

  const partnerIds = [...new Set([...byPartner.keys(), ...(await openPenaltyPartners(db))])].filter((id) => !onlyPartnerId || id === onlyPartnerId);
  if (!partnerIds.length) return [];
  const orgs = await db.select().from(organizations).where(inArray(organizations.id, partnerIds)).orderBy(asc(organizations.name));
  const result = [];
  for (const org of orgs) {
    const items = byPartner.get(org.id) ?? [];
    const penalties = org.type === "installation_partner" ? await openPenalties(db, org.id) : [];
    const ready = items.filter((i) => i.amountCents !== null);
    result.push({
      partner: { id: org.id, name: org.name, type: org.type, email: org.email },
      kind: (org.type === "installation_partner" ? "installation" : "sales_fee") as "installation" | "sales_fee",
      vatMode: vatModeFor(org),
      items,
      penalties,
      readyCents: ready.reduce((s, i) => s + i.amountCents!, 0) - penalties.reduce((s, p) => s + p.amountCents, 0),
      canBill: ready.length > 0,
    });
  }
  return result;
}

const penaltyNotBilled = sql`NOT EXISTS (SELECT 1 FROM ${selfBillingLines} WHERE ${selfBillingLines.kind} = 'penalty' AND ${selfBillingLines.penaltyId} = ${partnerPenalties.id})`;

async function openPenalties(db: DbOrTx, partnerId: string) {
  return db
    .select({ id: partnerPenalties.id, amountCents: partnerPenalties.amountCents, reason: partnerPenalties.reason, createdAt: partnerPenalties.createdAt })
    .from(partnerPenalties)
    .where(and(eq(partnerPenalties.partnerOrganizationId, partnerId), eq(partnerPenalties.status, "open"), penaltyNotBilled))
    .orderBy(asc(partnerPenalties.createdAt));
}

async function openPenaltyPartners(db: DbOrTx) {
  const rows = await db
    .selectDistinct({ id: partnerPenalties.partnerOrganizationId })
    .from(partnerPenalties)
    .where(and(eq(partnerPenalties.status, "open"), penaltyNotBilled));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------- Concept en definitief

async function recalc(tx: DbOrTx, invoiceId: string) {
  const lines = await tx.select().from(selfBillingLines).where(eq(selfBillingLines.invoiceId, invoiceId));
  const rates = new Map<number, number>();
  for (const l of lines) rates.set(l.vatRateBasisPoints, (rates.get(l.vatRateBasisPoints) ?? 0) + l.amountCents);
  const vatBreakdown = [...rates.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, base]) => ({ rateBasisPoints: rate, baseCents: base, vatCents: Math.round((base * rate) / 10_000) }));
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const vatCents = vatBreakdown.reduce((s, v) => s + v.vatCents, 0);
  await tx.update(selfBillingInvoices).set({ subtotalCents, vatCents, totalCents: subtotalCents + vatCents, vatBreakdown }).where(eq(selfBillingInvoices.id, invoiceId));
}

async function lineVatRate(db: DbOrTx, vatMode: VatMode) {
  if (vatMode === "reverse_charge") return 0;
  const rate = await effectiveVatRate(db, "hoog");
  if (rate === null) throw badRequest("no_vat_rate", "Btw-tarief 'hoog' ontbreekt");
  return rate;
}

/** Concept-selfbillingfactuur met alle uitbetaalbare posten (en openstaande boetes) van één partner. */
export async function createDraft(db: Db, actor: ActorContext, partnerId: string) {
  return db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, partnerId)).for("update");
    if (!org) throw notFound("Partner");
    const [open] = await openItems(tx, partnerId);
    const ready = open?.items.filter((i) => i.amountCents !== null) ?? [];
    if (!open || !ready.length) throw badRequest("nothing_to_bill", "Er is niets uit te betalen aan deze partner");
    const vatMode = vatModeFor(org);
    const rate = await lineVatRate(tx, vatMode);
    const [inv] = await tx
      .insert(selfBillingInvoices)
      .values({ partnerOrganizationId: partnerId, kind: open.kind, vatMode, createdBy: actor.userId })
      .returning();
    let sort = 0;
    for (const i of ready) {
      await tx.insert(selfBillingLines).values({
        invoiceId: inv!.id,
        sortOrder: sort++,
        kind: i.kind,
        projectId: i.projectId,
        quoteId: i.quoteId,
        advisorName: i.advisorName,
        description: i.description,
        basisCents: i.basisCents,
        feeBasisPoints: i.feeBasisPoints,
        amountCents: i.amountCents!,
        vatRateBasisPoints: rate,
      });
    }
    for (const p of open.penalties) {
      // Boete is een schadevergoeding: buiten de btw.
      await tx.insert(selfBillingLines).values({ invoiceId: inv!.id, sortOrder: sort++, kind: "penalty", penaltyId: p.id, description: `Boete: ${p.reason}`, amountCents: -p.amountCents, vatRateBasisPoints: 0 });
    }
    await recalc(tx, inv!.id);
    await recordAudit(tx, actor, { action: "selfbilling.draft_created", entityType: "self_billing_invoice", entityId: inv!.id, after: { partnerId, lines: sort } });
    return getSelfBillingInvoice(tx, inv!.id);
  });
}

async function draftForUpdate(tx: DbOrTx, id: string) {
  const [inv] = await tx.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.id, id)).for("update");
  if (!inv) throw notFound("Selfbillingfactuur");
  if (inv.status !== "draft") throw conflict("not_draft", "Alleen een concept kan worden gewijzigd");
  return inv;
}

/** Correctieregel (bv. afspraak bij annulering). Positief = extra uitbetalen, negatief = inhouden. */
export async function addCorrection(db: Db, actor: ActorContext, id: string, input: { description: string; amountCents: number; withVat: boolean }) {
  return db.transaction(async (tx) => {
    const inv = await draftForUpdate(tx, id);
    const rate = input.withVat ? await lineVatRate(tx, inv.vatMode as VatMode) : 0;
    const [{ max }] = (await tx.select({ max: sql<number>`coalesce(max(${selfBillingLines.sortOrder}), 0)` }).from(selfBillingLines).where(eq(selfBillingLines.invoiceId, id))) as [{ max: number }];
    await tx.insert(selfBillingLines).values({ invoiceId: id, sortOrder: Number(max) + 1, kind: "correction", description: input.description, amountCents: input.amountCents, vatRateBasisPoints: rate });
    await recalc(tx, id);
    await recordAudit(tx, actor, { action: "selfbilling.correction_added", entityType: "self_billing_invoice", entityId: id, after: input });
    return getSelfBillingInvoice(tx, id);
  });
}

/** Regel uit een concept halen; de post komt dan terug bij "nog uit te betalen". */
export async function removeLine(db: Db, actor: ActorContext, id: string, lineId: string) {
  return db.transaction(async (tx) => {
    await draftForUpdate(tx, id);
    const [line] = await tx.delete(selfBillingLines).where(and(eq(selfBillingLines.id, lineId), eq(selfBillingLines.invoiceId, id))).returning();
    if (!line) throw notFound("Regel");
    await recalc(tx, id);
    await recordAudit(tx, actor, { action: "selfbilling.line_removed", entityType: "self_billing_invoice", entityId: id, before: line });
    return getSelfBillingInvoice(tx, id);
  });
}

export async function deleteDraft(db: Db, actor: ActorContext, id: string) {
  await db.transaction(async (tx) => {
    const inv = await draftForUpdate(tx, id);
    await tx.delete(selfBillingInvoices).where(eq(selfBillingInvoices.id, id));
    await recordAudit(tx, actor, { action: "selfbilling.draft_deleted", entityType: "self_billing_invoice", entityId: id, before: { partnerId: inv.partnerOrganizationId, totalCents: inv.totalCents } });
  });
}

/** Voorvoegsel van de factuurreeks van een partner; bij eerste gebruik afgeleid van de naam (uniek). */
async function ensurePrefix(tx: DbOrTx, org: typeof organizations.$inferSelect) {
  if (org.selfBillingPrefix) return org.selfBillingPrefix;
  const base = (org.name.replace(/[^A-Za-z]/g, "").slice(0, 3) || "SB").toUpperCase();
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    const [taken] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.selfBillingPrefix, candidate));
    if (!taken) {
      await tx.update(organizations).set({ selfBillingPrefix: candidate }).where(eq(organizations.id, org.id));
      return candidate;
    }
  }
}

const partnerSnapshot = (o: typeof organizations.$inferSelect) => ({
  name: o.name,
  street: o.street,
  houseNumber: o.houseNumber,
  postalCode: o.postalCode,
  city: o.city,
  kvkNumber: o.kvkNumber,
  vatNumber: o.vatNumber,
  iban: o.iban,
  email: o.email,
});

export interface ApprovalDeps {
  transport: EmailTransport | null;
  /** Basis-URL voor de akkoordlink in de e-mail (APP_BASE_URL). */
  baseUrl: string;
}

/** Vingerafdruk van alles wat de ontvanger accordeert. Vastgelegd bij definitief maken, gecontroleerd bij akkoord. */
export function selfBillingContentHash(inv: Awaited<ReturnType<typeof getSelfBillingInvoice>>) {
  const canonical = {
    number: inv.number,
    date: inv.invoiceDate,
    partner: inv.partnerSnapshot,
    company: (inv.companySnapshot as { name: string }).name,
    vatMode: inv.vatMode,
    lines: inv.lines.map((l) => [l.kind, l.description, l.advisorName, l.basisCents, l.feeBasisPoints, l.amountCents, l.vatRateBasisPoints]),
    totals: [inv.subtotalCents, inv.vatCents, inv.totalCents],
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Definitief: nummer uit de reeks van de partner, momentopnames, boetes verrekend; daarna ter akkoord naar de partner. */
export async function finalizeSelfBilling(db: Db, deps: ApprovalDeps, actor: ActorContext, id: string) {
  await db.transaction(async (tx) => {
    const inv = await draftForUpdate(tx, id);
    const lines = await tx.select().from(selfBillingLines).where(eq(selfBillingLines.invoiceId, id));
    if (!lines.length) throw badRequest("empty", "Het concept heeft geen regels");
    const penaltyIds = lines.filter((l) => l.penaltyId).map((l) => l.penaltyId!);
    if (penaltyIds.length) {
      const changed = await tx.select({ id: partnerPenalties.id }).from(partnerPenalties).where(and(inArray(partnerPenalties.id, penaltyIds), ne(partnerPenalties.status, "open")));
      if (changed.length) throw conflict("penalty_changed", "Een boete in dit concept is intussen kwijtgescholden; verwijder die regel eerst");
    }
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, inv.partnerOrganizationId)).for("update");
    const prefix = await ensurePrefix(tx, org!);
    const date = todayIso();
    const year = Number(date.slice(0, 4));
    const [seq] = await tx
      .insert(selfBillingSequences)
      .values({ partnerOrganizationId: org!.id, year, lastNumber: 1 })
      .onConflictDoUpdate({ target: [selfBillingSequences.partnerOrganizationId, selfBillingSequences.year], set: { lastNumber: sql`${selfBillingSequences.lastNumber} + 1` } })
      .returning();
    const number = `${prefix}-${year}-${String(seq!.lastNumber).padStart(4, "0")}`;
    await recalc(tx, id);
    await tx
      .update(selfBillingInvoices)
      .set({ status: "final", number, invoiceDate: date, finalizedAt: new Date(), partnerSnapshot: partnerSnapshot(org!), companySnapshot: await getCompany(tx), approvalStatus: "pending" })
      .where(eq(selfBillingInvoices.id, id));
    const contentHash = selfBillingContentHash(await getSelfBillingInvoice(tx, id));
    await tx.update(selfBillingInvoices).set({ contentHash }).where(eq(selfBillingInvoices.id, id));
    if (penaltyIds.length) await tx.update(partnerPenalties).set({ status: "settled" }).where(inArray(partnerPenalties.id, penaltyIds));
    await recordAudit(tx, actor, { action: "selfbilling.finalized", entityType: "self_billing_invoice", entityId: id, after: { number, partnerId: org!.id, contentHash } });
  });
  await requestApproval(db, deps, actor, id);
  return getSelfBillingInvoice(db, id);
}

/**
 * Stuurt de factuur ter akkoord: nieuwe persoonlijke link (een eerdere link vervalt) en e-mail met akkoordknop.
 * Ook te gebruiken om na "niet akkoord" en overleg opnieuw te vragen. Geeft het adres terug (null = geen e-mail).
 */
export async function requestApproval(db: Db, deps: ApprovalDeps, actor: ActorContext, id: string) {
  const token = randomToken();
  const inv = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.id, id)).for("update");
    if (!row) throw notFound("Selfbillingfactuur");
    if (row.status !== "final" || row.approvalStatus === "approved") throw conflict("not_awaiting_approval", "Deze factuur wacht niet (meer) op akkoord");
    await tx.update(selfBillingInvoices).set({ approvalStatus: "pending", approvalTokenHash: sha256(token), disputedAt: null, disputeReason: null }).where(eq(selfBillingInvoices.id, id));
    return getSelfBillingInvoice(tx, id);
  });
  const partner = inv.partnerSnapshot as { name: string; email: string | null };
  await recordAudit(db, actor, { action: "selfbilling.approval_requested", entityType: "self_billing_invoice", entityId: id, metadata: { sentTo: partner.email } });
  if (!partner.email) return { sentTo: null };
  const company = inv.companySnapshot as Company;
  const url = `${deps.baseUrl.replace(/\/$/, "")}/selfbilling-akkoord/${token}`;
  const rows = inv.lines
    .map((l) => `<tr><td style="padding:4px 8px 4px 0">${escapeHtml(l.description)}${l.advisorName ? `<br><span style="color:#5f6b62">Adviseur: ${escapeHtml(l.advisorName)}</span>` : ""}</td><td style="padding:4px 0;text-align:right;white-space:nowrap">${euro(l.amountCents)}</td></tr>`)
    .join("");
  const html = `<p>Beste ${escapeHtml(partner.name)},</p>
<p>${escapeHtml(company.name)} heeft op grond van onze zelffactureringsovereenkomst namens u de selfbillingfactuur <strong>${escapeHtml(inv.number!)}</strong> van ${dateNl(inv.invoiceDate)} opgemaakt, voor een bedrag van <strong>${euro(inv.totalCents)}</strong>.</p>
<p><strong>Wij betalen deze factuur uit zodra u hem heeft geaccordeerd.</strong> Controleer de specificatie en geef via de knop uw akkoord. Klopt er iets niet? Dan kunt u daar ook aangeven waarom niet.</p>
${button(url, "Factuur bekijken en akkoord geven")}
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;border-top:1px solid #dfe3dd">${rows}
<tr><td style="padding:8px 8px 0 0;border-top:1px solid #dfe3dd">Totaal excl. btw</td><td style="padding:8px 0 0;text-align:right;border-top:1px solid #dfe3dd">${euro(inv.subtotalCents)}</td></tr>
<tr><td style="padding:4px 8px 0 0">${inv.vatMode === "reverse_charge" ? "Btw verlegd" : "Btw"}</td><td style="padding:4px 0 0;text-align:right">${euro(inv.vatCents)}</td></tr>
<tr><td style="padding:4px 8px 0 0"><strong>Totaal</strong></td><td style="padding:4px 0 0;text-align:right"><strong>${euro(inv.totalCents)}</strong></td></tr></table>
<p style="font-size:13px;color:#5f6b62">Factuur uitgereikt door afnemer.${inv.vatMode === "reverse_charge" ? " Btw verlegd." : ""} De link is persoonlijk; stuur deze e-mail niet door.</p>`;
  await sendEmail(db, deps.transport, {
    to: partner.email,
    subject: `Ter akkoord: selfbillingfactuur ${inv.number} van ${company.name}`,
    html: layout(company, html),
    text: `${html.replace(/<br>/g, "\n").replace(/<\/(p|tr)>/g, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim()}\n\nAkkoord geven: ${url}`,
    template: "selfbilling.invoice",
    related: { type: "self_billing_invoice", id },
  });
  await db.update(selfBillingInvoices).set({ sentAt: new Date() }).where(eq(selfBillingInvoices.id, id));
  return { sentTo: partner.email };
}

export interface ApprovalEvidence {
  method: "email_link" | "portal";
  ip?: string | null;
  userAgent?: string | null;
  userId?: string | null;
  /** Beheerder die via "Inloggen als" handelde (alleen toegestaan in testmodus). */
  impersonatorUserId?: string | null;
  requestId?: string | null;
}

async function invoiceIdByToken(db: DbOrTx, token: string) {
  const [row] = await db.select({ id: selfBillingInvoices.id }).from(selfBillingInvoices).where(eq(selfBillingInvoices.approvalTokenHash, sha256(token)));
  if (!row) throw notFound("Factuur (de link is ongeldig of vervangen door een nieuwere)");
  return row.id;
}

/** Wat de ontvanger via de akkoordlink ziet. */
export async function getByApprovalToken(db: DbOrTx, token: string) {
  const inv = await getSelfBillingInvoice(db, await invoiceIdByToken(db, token));
  return publicView(inv);
}

export const publicView = (inv: Awaited<ReturnType<typeof getSelfBillingInvoice>>) => ({
  number: inv.number,
  kind: inv.kind,
  status: inv.status,
  invoiceDate: inv.invoiceDate,
  vatMode: inv.vatMode,
  subtotalCents: inv.subtotalCents,
  vatCents: inv.vatCents,
  totalCents: inv.totalCents,
  vatBreakdown: inv.vatBreakdown,
  partnerSnapshot: inv.partnerSnapshot,
  companySnapshot: inv.companySnapshot,
  lines: inv.lines,
  approval: inv.approval,
  paidAt: inv.paidAt,
  // Velden die het document nodig heeft maar niets prijsgeven.
  id: inv.id,
  partnerOrganizationId: inv.partnerOrganizationId,
  partnerName: inv.partnerName,
  sentAt: inv.sentAt,
  createdAt: inv.createdAt,
});

/** Akkoord of niet akkoord van de ontvanger, met bewijs (naam, tijd, IP, apparaat, inhoud-hash). */
export async function decideApproval(
  db: Db,
  id: string,
  input: { decision: "approve" | "dispute"; name: string; reason?: string | null },
  evidence: ApprovalEvidence,
  notify?: ApprovalDeps,
) {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.id, id)).for("update");
    if (!row) throw notFound("Selfbillingfactuur");
    if (row.status === "draft") throw conflict("not_final", "Deze factuur is nog niet definitief");
    if (row.approvalStatus === "approved") throw conflict("already_approved", "Deze factuur is al geaccordeerd");
    if (input.decision === "dispute" && row.approvalStatus === "disputed") throw conflict("already_disputed", "U heeft al aangegeven niet akkoord te zijn; wij nemen contact met u op");
    const inv = await getSelfBillingInvoice(tx, id);
    const hash = selfBillingContentHash(inv);
    if (row.contentHash && hash !== row.contentHash) throw conflict("content_changed", "De factuur komt niet overeen met de vastgelegde versie; neem contact op met Gecko");
    const sentTo = (inv.partnerSnapshot as { email: string | null }).email;
    const proof = { ...evidence, sentTo, contentHash: hash, decidedAt: new Date().toISOString(), name: input.name };
    if (input.decision === "approve") {
      await tx.update(selfBillingInvoices).set({ approvalStatus: "approved", approvedAt: new Date(), approvedByName: input.name, approvalEvidence: proof }).where(eq(selfBillingInvoices.id, id));
    } else {
      await tx.update(selfBillingInvoices).set({ approvalStatus: "disputed", disputedAt: new Date(), disputeReason: input.reason ?? null }).where(eq(selfBillingInvoices.id, id));
    }
    const actor: ActorContext = { userId: evidence.userId ?? null, organizationId: row.partnerOrganizationId, permissions: new Set(), ip: evidence.ip ?? undefined, requestId: evidence.requestId ?? undefined, impersonatorUserId: evidence.impersonatorUserId ?? null };
    await recordAudit(tx, actor, {
      action: input.decision === "approve" ? "selfbilling.approved" : "selfbilling.disputed",
      entityType: "self_billing_invoice",
      entityId: id,
      metadata: { ...proof, reason: input.reason ?? undefined },
    });
    return { number: row.number!, company: inv.companySnapshot as Company, partner: inv.partnerName };
  });
  // Bij "niet akkoord" krijgt Gecko een seintje.
  if (input.decision === "dispute" && notify && result.company.email) {
    const html = `<p>${escapeHtml(result.partner)} (${escapeHtml(input.name)}) is <strong>niet akkoord</strong> met selfbillingfactuur <strong>${escapeHtml(result.number)}</strong>.</p><p>Reden: ${escapeHtml(input.reason ?? "—")}</p><p>Bekijk de factuur in het CRM onder Selfbilling. Na overleg kunt u hem opnieuw ter akkoord sturen.</p>`;
    await sendEmail(db, notify.transport, {
      to: result.company.email,
      subject: `Niet akkoord: selfbillingfactuur ${result.number} (${result.partner})`,
      html: layout(result.company, html),
      text: html.replace(/<[^>]+>/g, ""),
      template: "selfbilling.disputed",
      related: { type: "self_billing_invoice", id },
    });
  }
  return getSelfBillingInvoice(db, id);
}

export async function decideByToken(db: Db, token: string, input: { decision: "approve" | "dispute"; name: string; reason?: string | null }, evidence: ApprovalEvidence, notify: ApprovalDeps) {
  const id = await invoiceIdByToken(db, token);
  return publicView(await decideApproval(db, id, input, evidence, notify));
}

/** Uitbetaling vastleggen; alleen na akkoord van de ontvanger. */
export async function markSelfBillingPaid(db: Db, actor: ActorContext, id: string, paidAt: string) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(selfBillingInvoices).where(eq(selfBillingInvoices.id, id)).for("update");
    if (!inv) throw notFound("Selfbillingfactuur");
    if (inv.status !== "final") throw conflict("not_final", "Alleen een definitieve, onbetaalde factuur kan als betaald worden gemarkeerd");
    if (inv.approvalStatus !== "approved") throw conflict("not_approved", "De ontvanger heeft deze factuur nog niet geaccordeerd; uitbetalen kan pas na akkoord");
    await tx.update(selfBillingInvoices).set({ status: "paid", paidAt }).where(eq(selfBillingInvoices.id, id));
    await recordAudit(tx, actor, { action: "selfbilling.paid", entityType: "self_billing_invoice", entityId: id, after: { paidAt } });
    return getSelfBillingInvoice(tx, id);
  });
}

// ---------------------------------------------------------------- Lezen

export async function listSelfBilling(db: DbOrTx, q: { partnerId?: string; onlyFinal?: boolean } = {}) {
  const filters = [];
  if (q.partnerId) filters.push(eq(selfBillingInvoices.partnerOrganizationId, q.partnerId));
  if (q.onlyFinal) filters.push(ne(selfBillingInvoices.status, "draft"));
  return db
    .select({ invoice: selfBillingInvoices, partnerName: organizations.name })
    .from(selfBillingInvoices)
    .innerJoin(organizations, eq(organizations.id, selfBillingInvoices.partnerOrganizationId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(selfBillingInvoices.createdAt))
    .limit(500)
    .then((rows) => rows.map((r) => ({ ...summary(r.invoice), partnerName: r.partnerName })));
}

const summary = (i: SelfBillingInvoice) => ({
  id: i.id,
  number: i.number,
  kind: i.kind,
  status: i.status,
  partnerOrganizationId: i.partnerOrganizationId,
  invoiceDate: i.invoiceDate,
  subtotalCents: i.subtotalCents,
  vatCents: i.vatCents,
  totalCents: i.totalCents,
  vatMode: i.vatMode,
  paidAt: i.paidAt,
  sentAt: i.sentAt,
  approvalStatus: i.approvalStatus as "pending" | "approved" | "disputed" | null,
  createdAt: i.createdAt,
});

export async function getSelfBillingInvoice(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ invoice: selfBillingInvoices, partner: organizations })
    .from(selfBillingInvoices)
    .innerJoin(organizations, eq(organizations.id, selfBillingInvoices.partnerOrganizationId))
    .where(eq(selfBillingInvoices.id, id));
  if (!row) throw notFound("Selfbillingfactuur");
  const lines = await db.select().from(selfBillingLines).where(eq(selfBillingLines.invoiceId, id)).orderBy(asc(selfBillingLines.sortOrder));
  const inv = row.invoice;
  return {
    ...summary(inv),
    partnerName: row.partner.name,
    vatBreakdown: inv.vatBreakdown,
    // Concept: actuele gegevens; definitief: de vastgelegde momentopname.
    partnerSnapshot: inv.partnerSnapshot ?? partnerSnapshot(row.partner),
    companySnapshot: inv.companySnapshot ?? (await getCompany(db)),
    note: inv.note,
    approval: {
      status: inv.approvalStatus as "pending" | "approved" | "disputed" | null,
      approvedAt: inv.approvedAt,
      approvedByName: inv.approvedByName,
      method: (inv.approvalEvidence as { method?: string } | null)?.method ?? null,
      viaImpersonation: !!(inv.approvalEvidence as { impersonatorUserId?: string | null } | null)?.impersonatorUserId,
      disputedAt: inv.disputedAt,
      disputeReason: inv.disputeReason,
    },
    lines: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      projectId: l.projectId,
      quoteId: l.quoteId,
      advisorName: l.advisorName,
      description: l.description,
      basisCents: l.basisCents,
      feeBasisPoints: l.feeBasisPoints,
      amountCents: l.amountCents,
      vatRateBasisPoints: l.vatRateBasisPoints,
    })),
  };
}

/** Export voor Exact (inkoopboek): één regel per factuur per btw-tarief. */
export async function exportSelfBillingCsv(db: DbOrTx, from: string, to: string) {
  const rows = await db
    .select({ invoice: selfBillingInvoices, partnerName: organizations.name, kvk: organizations.kvkNumber })
    .from(selfBillingInvoices)
    .innerJoin(organizations, eq(organizations.id, selfBillingInvoices.partnerOrganizationId))
    .where(and(ne(selfBillingInvoices.status, "draft"), sql`${selfBillingInvoices.invoiceDate} BETWEEN ${from} AND ${to}`))
    .orderBy(asc(selfBillingInvoices.invoiceDate), asc(selfBillingInvoices.number));
  const cell = (v: unknown) => {
    const raw = String(v ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) && !/^-?\d/.test(raw) ? `'${raw}` : raw; // geen formules in Excel
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const amount = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const out = [["Factuurnummer", "Datum", "Crediteur", "KvK", "Soort", "Btw-behandeling", "Btw-tarief", "Bedrag excl. btw", "Btw", "Status", "Betaald op"].map(cell).join(";")];
  for (const r of rows) {
    for (const v of r.invoice.vatBreakdown) {
      out.push(
        [
          r.invoice.number,
          r.invoice.invoiceDate,
          r.partnerName,
          r.kvk,
          r.invoice.kind === "sales_fee" ? "Fee verkooppartner" : "Installatie",
          r.invoice.vatMode === "reverse_charge" ? "Verlegd" : "Normaal",
          `${v.rateBasisPoints / 100}%`,
          amount(v.baseCents),
          amount(v.vatCents),
          r.invoice.status === "paid" ? "Betaald" : "Open",
          r.invoice.paidAt,
        ]
          .map(cell)
          .join(";"),
      );
    }
  }
  return out.join("\r\n");
}

/**
 * Wekelijkse bundeling (instelling, standaard uit): op maandag vanaf 9:00 een concept per partner met uitbetaalbare
 * posten, tenzij die partner al een concept heeft. Definitief maken en ter akkoord sturen doet een medewerker.
 */
export async function autoWeeklyDrafts(db: Db, now = new Date()) {
  if (!(await getSetting(db, "selfbilling.auto_weekly"))) return { created: 0 };
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (weekday !== "Mon" || hour < 9) return { created: 0 };
  const system: ActorContext = { userId: null, organizationId: null, permissions: new Set() };
  let created = 0;
  for (const p of await openItems(db)) {
    if (!p.canBill) continue;
    const [draft] = await db.select({ id: selfBillingInvoices.id }).from(selfBillingInvoices).where(and(eq(selfBillingInvoices.partnerOrganizationId, p.partner.id), eq(selfBillingInvoices.status, "draft")));
    if (draft) continue;
    await createDraft(db, system, p.partner.id);
    created++;
  }
  return { created };
}
