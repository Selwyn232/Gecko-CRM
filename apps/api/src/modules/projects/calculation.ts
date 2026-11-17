import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { todayIso } from "../../lib/dates.js";
import { notFound } from "../../lib/errors.js";
import { multiplyCents } from "../../lib/money.js";
import { effectivePrice, laborRate } from "../catalog/prices.js";
import { bomItems, products } from "../catalog/schema.js";
import { calculateCost } from "../catalog/service.js";
import { invoices } from "../invoices/schema.js";
import { appointments, partnerPenalties } from "../planning/schema.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { selfBillingInvoices, selfBillingLines } from "../selfbilling/schema.js";
import { quotePartnerAmount } from "../selfbilling/service.js";
import { projects } from "./schema.js";

/** Inkoop (materiaal) voor één offerteregel: inkoopdelen uit de stuklijst, of de inkoopprijs van het product. */
async function materialAmount(db: DbOrTx, productId: string, quantity: string, date: string) {
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  if (!p) return { cents: 0, missing: [] as string[] };
  const [hasBom] = await db.select({ id: bomItems.id }).from(bomItems).where(eq(bomItems.parentProductId, productId)).limit(1);
  if (hasBom) {
    const cost = await calculateCost(db, productId, { date });
    const material = cost.lines.filter((l) => l.type !== "labor" && l.type !== "extra_work" && l.type !== "service");
    const missing = material.filter((l) => l.totalCents === null).map((l) => l.code);
    return { cents: multiplyCents(material.reduce((s, l) => s + (l.totalCents ?? 0), 0), quantity), missing };
  }
  if (p.type === "labor" || p.type === "extra_work" || p.type === "service") return { cents: 0, missing: [] };
  if (!p.defaultSupplierOrganizationId) return { cents: 0, missing: [p.code] };
  const price = await effectivePrice(db, "purchase", productId, p.defaultSupplierOrganizationId, date);
  return price ? { cents: multiplyCents(price.priceCents, quantity), missing: [] } : { cents: 0, missing: [p.code] };
}

/** Arbeid voor een offerteregel tegen het standaard partnertarief (zolang de installateur niet bekend is). */
async function estimatedLabor(db: DbOrTx, productId: string, quantity: string, date: string) {
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  if (!p) return { cents: 0, missing: [] as string[] };
  const [hasBom] = await db.select({ id: bomItems.id }).from(bomItems).where(eq(bomItems.parentProductId, productId)).limit(1);
  if (hasBom) {
    const cost = await calculateCost(db, productId, { date });
    const labor = cost.lines.filter((l) => l.type === "labor" || l.type === "extra_work" || l.type === "service");
    return { cents: multiplyCents(labor.reduce((s, l) => s + (l.totalCents ?? 0), 0), quantity), missing: labor.filter((l) => l.totalCents === null).map((l) => l.code) };
  }
  if (p.type === "labor" || p.type === "extra_work" || p.type === "service") {
    const r = await laborRate(db, productId, null, date);
    return r ? { cents: multiplyCents(r.price.priceCents, quantity), missing: [] } : { cents: 0, missing: [p.code] };
  }
  return { cents: 0, missing: [] };
}

export interface CalcComponent {
  key: "revenue" | "material" | "partner" | "penalties" | "fee";
  label: string;
  /** Voorcalculatie (bij akkoord, prijzen van de offertedatum). */
  plannedCents: number;
  /** Nacalculatie (werkelijk); gelijk aan voor zolang niets is afgerekend. */
  actualCents: number;
  /** "actual" = werkelijk afgerekend, "planned" = nog voorcalculatie, "partial" = deels. */
  basis: "actual" | "planned" | "partial";
  note?: string;
}

/**
 * Voor- en nacalculatie van een project (excl. btw).
 * - Omzet: geaccepteerde offertes (voor) en gefactureerd incl. creditnota's (na; zolang niet alles gefactureerd: offertes).
 * - Materiaal: inkoopprijzen op de offertedatum (werkelijke inkoop volgt via Exact).
 * - Installateur: partnertarieven (voor) en definitieve selfbilling (na).
 * - Boetes partner: ingehouden/openstaande boetes op afspraken van dit project (verlagen de kosten).
 * - Fee verkoopkanaal: percentage bij versturen (voor) en definitieve selfbilling (na).
 */
export async function projectCalculation(db: DbOrTx, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound("Project");
  const accepted = await db.select().from(quotes).where(and(eq(quotes.projectId, projectId), eq(quotes.status, "accepted")));
  const missing: string[] = [];

  let revenue = 0;
  let material = 0;
  let partner = 0;
  let fee = 0;
  for (const q of accepted) {
    const date = q.priceDate ?? todayIso();
    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.id));
    const qRevenue = lines.reduce((s, l) => s + multiplyCents(l.unitPriceCents, l.quantity), 0);
    revenue += qRevenue;
    for (const l of lines) {
      const m = await materialAmount(db, l.productId, l.quantity, date);
      material += m.cents;
      missing.push(...m.missing.map((c) => `inkoopprijs ${c}`));
    }
    if (project.installationPartnerId) {
      const p = await quotePartnerAmount(db, q.id, project.installationPartnerId, date);
      partner += p.cents;
      missing.push(...p.missing.map((c) => `partnertarief ${c}`));
    } else {
      // Nog geen installateur: schatting met de standaard partnertarieven.
      for (const l of lines) {
        const e = await estimatedLabor(db, l.productId, l.quantity, date);
        partner += e.cents;
        missing.push(...e.missing.map((c) => `standaardtarief ${c}`));
      }
    }
    fee += Math.round((qRevenue * (q.feeBasisPoints ?? 0)) / 10_000);
  }


  // Werkelijk: facturen (incl. creditnota's), selfbilling en boetes.
  const [inv] = await db
    .select({ invoiced: sql<string>`coalesce(sum(${invoices.subtotalCents}), 0)`, finals: sql<number>`count(*) FILTER (WHERE ${invoices.type} = 'final')` })
    .from(invoices)
    .where(and(eq(invoices.projectId, projectId), ne(invoices.status, "draft")));
  const invoiced = Number(inv?.invoiced ?? 0);
  const finalInvoiced = Number(inv?.finals ?? 0) > 0;

  const quoteIds = accepted.map((q) => q.id);
  const settledRows = await db
    .select({ kind: selfBillingLines.kind, amount: sql<string>`sum(${selfBillingLines.amountCents})` })
    .from(selfBillingLines)
    .innerJoin(selfBillingInvoices, eq(selfBillingInvoices.id, selfBillingLines.invoiceId))
    .where(
      and(
        ne(selfBillingInvoices.status, "draft"),
        sql`(${selfBillingLines.projectId} = ${projectId} ${quoteIds.length ? sql`OR ${inArray(selfBillingLines.quoteId, quoteIds)}` : sql``})`,
      ),
    )
    .groupBy(selfBillingLines.kind);
  const settled = (k: string) => settledRows.filter((r) => r.kind === k).reduce((s, r) => s + Number(r.amount), 0);
  const hasSettled = (k: string) => settledRows.some((r) => r.kind === k);

  const [pen] = await db
    .select({ amount: sql<string>`coalesce(sum(${partnerPenalties.amountCents}), 0)` })
    .from(partnerPenalties)
    .innerJoin(appointments, eq(appointments.id, partnerPenalties.appointmentId))
    .where(and(eq(appointments.projectId, projectId), ne(partnerPenalties.status, "waived")));
  const penalties = Number(pen?.amount ?? 0);

  const partnerSettled = hasSettled("installation") || hasSettled("extra_work");
  const feeSettled = hasSettled("fee");
  const partnerActual = partnerSettled ? settled("installation") + settled("extra_work") : partner;
  const feeActual = feeSettled ? settled("fee") : fee;
  const revenueActual = finalInvoiced ? invoiced : revenue;

  const components: CalcComponent[] = [
    { key: "revenue", label: "Omzet", plannedCents: revenue, actualCents: revenueActual, basis: finalInvoiced ? "actual" : invoiced ? "partial" : "planned", note: finalInvoiced ? "gefactureerd, incl. creditnota's" : invoiced ? "nog niet volledig gefactureerd" : undefined },
    { key: "material", label: "Materiaal (inkoop)", plannedCents: -material, actualCents: -material, basis: "planned", note: "werkelijke inkoop volgt via Exact" },
    { key: "partner", label: "Installateur", plannedCents: -partner, actualCents: -partnerActual, basis: partnerSettled ? "actual" : "planned", note: partnerSettled ? "via selfbilling" : project.installationPartnerId ? undefined : "schatting met standaardtarief (installateur nog niet bekend)" },
    { key: "penalties", label: "Boetes installateur", plannedCents: 0, actualCents: penalties, basis: penalties ? "actual" : "planned" },
    { key: "fee", label: "Fee verkoopkanaal", plannedCents: -fee, actualCents: -feeActual, basis: feeSettled ? "actual" : "planned", note: feeSettled ? "via selfbilling" : undefined },
  ];
  const planned = components.reduce((s, c) => s + c.plannedCents, 0);
  const actual = components.reduce((s, c) => s + c.actualCents, 0);
  const pct = (m: number, base: number) => (base > 0 ? Math.round((m * 10_000) / base) : null);
  return {
    projectId,
    components,
    planned: { marginCents: planned, marginBasisPoints: pct(planned, revenue) },
    actual: { marginCents: actual, marginBasisPoints: pct(actual, revenueActual) },
    deviationCents: actual - planned,
    /** Afgerond = eindfactuur gemaakt én installateur afgerekend: dan is de nacalculatie definitief. */
    complete: finalInvoiced && partnerSettled,
    missing: [...new Set(missing)],
  };
}
