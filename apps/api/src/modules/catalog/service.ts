import { and, asc, desc, eq, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { multiplyCents } from "../../lib/money.js";
import { recordAudit } from "../audit/service.js";
import { effectivePrice } from "./prices.js";
import {
  bomItems,
  partnerRates,
  productGroups,
  products,
  purchasePrices,
  salesChannelProductGroups,
  salesChannels,
  salesPrices,
  vatCodes,
  vatRates,
  type Product,
} from "./schema.js";

// ---------------------------------------------------------------- Productgroepen

export type ProductGroupInput = { key: string; name: string; sortOrder?: number; isActive?: boolean };

export const listProductGroups = (db: DbOrTx) =>
  db.select().from(productGroups).orderBy(asc(productGroups.sortOrder), asc(productGroups.name));

export async function createProductGroup(db: Db, actor: ActorContext, input: ProductGroupInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(productGroups).values(input).returning();
    await recordAudit(tx, actor, { action: "product_group.created", entityType: "product_group", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateProductGroup(db: Db, actor: ActorContext, id: string, input: Partial<Omit<ProductGroupInput, "key">>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(productGroups).where(eq(productGroups.id, id));
    if (!before) throw notFound("Productgroep");
    const [after] = await tx.update(productGroups).set(input).where(eq(productGroups.id, id)).returning();
    await recordAudit(tx, actor, { action: "product_group.updated", entityType: "product_group", entityId: id, before, after });
    return after!;
  });
}

// ---------------------------------------------------------------- Verkoopkanalen

export type SalesChannelInput = {
  key: string;
  name: string;
  salesPartnerOrganizationId?: string | null;
  feeBasisPoints?: number | null;
  quoteValidityDays?: number;
  isActive?: boolean;
  productGroupIds: string[];
};

async function channelSnapshot(db: DbOrTx, id: string) {
  const [ch] = await db.select().from(salesChannels).where(eq(salesChannels.id, id));
  if (!ch) return null;
  const groups = await db
    .select({ id: salesChannelProductGroups.productGroupId })
    .from(salesChannelProductGroups)
    .where(eq(salesChannelProductGroups.salesChannelId, id));
  return { ...ch, productGroupIds: groups.map((g) => g.id).sort() };
}

export async function listSalesChannels(db: DbOrTx) {
  const channels = await db.select().from(salesChannels).orderBy(asc(salesChannels.name));
  const links = await db.select().from(salesChannelProductGroups);
  return channels.map((c) => ({
    ...c,
    productGroupIds: links.filter((l) => l.salesChannelId === c.id).map((l) => l.productGroupId).sort(),
  }));
}

export async function getSalesChannel(db: DbOrTx, id: string) {
  const ch = await channelSnapshot(db, id);
  if (!ch) throw notFound("Verkoopkanaal");
  return ch;
}

async function setChannelGroups(tx: DbOrTx, channelId: string, groupIds: string[]) {
  const unique = [...new Set(groupIds)];
  if (unique.length) {
    const found = await tx.select({ id: productGroups.id }).from(productGroups).where(inArray(productGroups.id, unique));
    if (found.length !== unique.length) throw badRequest("unknown_product_group", "Een of meer productgroepen bestaan niet");
  }
  await tx.delete(salesChannelProductGroups).where(eq(salesChannelProductGroups.salesChannelId, channelId));
  if (unique.length) {
    await tx.insert(salesChannelProductGroups).values(unique.map((productGroupId) => ({ salesChannelId: channelId, productGroupId })));
  }
}

export async function createSalesChannel(db: Db, actor: ActorContext, input: SalesChannelInput) {
  const { productGroupIds, ...data } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(salesChannels).values(data).returning();
    await setChannelGroups(tx, row!.id, productGroupIds);
    const after = (await channelSnapshot(tx, row!.id))!;
    await recordAudit(tx, actor, { action: "sales_channel.created", entityType: "sales_channel", entityId: row!.id, after });
    return after;
  });
}

export async function updateSalesChannel(db: Db, actor: ActorContext, id: string, input: Partial<Omit<SalesChannelInput, "key">>) {
  const { productGroupIds, ...data } = input;
  return db.transaction(async (tx) => {
    const before = await channelSnapshot(tx, id);
    if (!before) throw notFound("Verkoopkanaal");
    if (Object.keys(data).length) await tx.update(salesChannels).set(data).where(eq(salesChannels.id, id));
    if (productGroupIds) await setChannelGroups(tx, id, productGroupIds);
    const after = (await channelSnapshot(tx, id))!;
    await recordAudit(tx, actor, { action: "sales_channel.updated", entityType: "sales_channel", entityId: id, before, after });
    return after;
  });
}

// ---------------------------------------------------------------- Btw

export async function listVatCodes(db: DbOrTx, date = todayIso()) {
  const codes = await db.select().from(vatCodes).orderBy(asc(vatCodes.code));
  const rates = await db.select().from(vatRates).orderBy(desc(vatRates.validFrom));
  return codes.map((c) => {
    const versions = rates.filter((r) => r.vatCode === c.code);
    return {
      ...c,
      currentRateBasisPoints: versions.find((r) => r.validFrom <= date)?.rateBasisPoints ?? null,
      rates: versions,
    };
  });
}

export async function effectiveVatRate(db: DbOrTx, code: string, date = todayIso()): Promise<number | null> {
  const [row] = await db
    .select()
    .from(vatRates)
    .where(and(eq(vatRates.vatCode, code), lte(vatRates.validFrom, date)))
    .orderBy(desc(vatRates.validFrom))
    .limit(1);
  return row?.rateBasisPoints ?? null;
}

export async function addVatRate(db: Db, actor: ActorContext, code: string, rateBasisPoints: number, validFrom: string) {
  if (validFrom < todayIso()) throw badRequest("valid_from_in_past", "Ingangsdatum mag niet in het verleden liggen");
  return db.transaction(async (tx) => {
    const [vc] = await tx.select().from(vatCodes).where(eq(vatCodes.code, code));
    if (!vc) throw notFound("Btw-code");
    const [row] = await tx.insert(vatRates).values({ vatCode: code, rateBasisPoints, validFrom, createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, { action: "vat_rate.created", entityType: "vat_code", entityId: code, after: row });
    return row!;
  });
}

// ---------------------------------------------------------------- Producten

export type ProductInput = {
  code: string;
  name: string;
  description?: string | null;
  productGroupId: string;
  type: Product["type"];
  unit?: string;
  vatCode: string;
  defaultSupplierOrganizationId?: string | null;
  isActive?: boolean;
};

export async function listProducts(
  db: DbOrTx,
  q: { productGroupId?: string; type?: Product["type"]; isActive?: boolean; search?: string },
) {
  const filters: SQL[] = [];
  if (q.productGroupId) filters.push(eq(products.productGroupId, q.productGroupId));
  if (q.type) filters.push(eq(products.type, q.type));
  if (q.isActive !== undefined) filters.push(eq(products.isActive, q.isActive));
  if (q.search) filters.push(or(ilike(products.code, `%${q.search}%`), ilike(products.name, `%${q.search}%`))!);
  return db
    .select()
    .from(products)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(products.code));
}

export async function getProduct(db: DbOrTx, id: string) {
  const [p] = await db.select().from(products).where(eq(products.id, id));
  if (!p) throw notFound("Product");
  const bom = await db
    .select({ id: bomItems.id, componentProductId: bomItems.componentProductId, quantity: bomItems.quantity, code: products.code, name: products.name, type: products.type })
    .from(bomItems)
    .innerJoin(products, eq(products.id, bomItems.componentProductId))
    .where(eq(bomItems.parentProductId, id))
    .orderBy(asc(products.code));
  return { ...p, bom };
}

export async function createProduct(db: Db, actor: ActorContext, input: ProductInput) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(products).values({ ...input, code: input.code.trim().toUpperCase() }).returning();
    await recordAudit(tx, actor, { action: "product.created", entityType: "product", entityId: row!.id, after: row });
    return row!;
  });
}

/** Of een product al ergens gebruikt is. Uitbreiden zodra offertes/facturen bestaan. */
async function productIsInUse(tx: DbOrTx, id: string) {
  for (const t of [salesPrices, purchasePrices, partnerRates] as const) {
    const [hit] = await tx.select({ id: t.id }).from(t).where(eq(t.productId, id)).limit(1);
    if (hit) return true;
  }
  const [bomHit] = await tx.select({ id: bomItems.id }).from(bomItems).where(eq(bomItems.componentProductId, id)).limit(1);
  return !!bomHit;
}

export async function updateProduct(db: Db, actor: ActorContext, id: string, input: Partial<ProductInput>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, id));
    if (!before) throw notFound("Product");
    const patch = { ...input };
    if (patch.code !== undefined) {
      patch.code = patch.code.trim().toUpperCase();
      if (patch.code !== before.code && (await productIsInUse(tx, id))) {
        throw conflict("product_code_locked", "Productcode kan niet meer worden gewijzigd: het product is al in gebruik");
      }
    }
    if (patch.productGroupId !== undefined && patch.productGroupId !== before.productGroupId && (await productIsInUse(tx, id))) {
      throw conflict("product_group_locked", "Productgroep kan niet meer worden gewijzigd: het product is al in gebruik");
    }
    const [after] = await tx.update(products).set(patch).where(eq(products.id, id)).returning();
    await recordAudit(tx, actor, { action: "product.updated", entityType: "product", entityId: id, before, after });
    return after!;
  });
}

// ---------------------------------------------------------------- Stuklijst

/** Vervangt de volledige stuklijst van een product. Weigert cirkels (A bevat B bevat A). */
export async function replaceBom(
  db: Db,
  actor: ActorContext,
  parentId: string,
  items: { componentProductId: string; quantity: number }[],
) {
  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(products).where(eq(products.id, parentId));
    if (!parent) throw notFound("Product");

    const ids = items.map((i) => i.componentProductId);
    if (new Set(ids).size !== ids.length) throw badRequest("duplicate_component", "Een component staat dubbel in de stuklijst");
    if (ids.includes(parentId)) throw badRequest("bom_cycle", "Een product kan niet zichzelf bevatten");
    if (ids.length) {
      const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, ids));
      if (found.length !== ids.length) throw badRequest("unknown_product", "Een of meer componenten bestaan niet");
    }
    for (const id of ids) {
      if (await reaches(tx, id, parentId)) throw badRequest("bom_cycle", "Deze stuklijst zou een cirkel veroorzaken");
    }

    const before = (await getProduct(tx, parentId)).bom.map((b) => ({ componentProductId: b.componentProductId, quantity: b.quantity }));
    await tx.delete(bomItems).where(eq(bomItems.parentProductId, parentId));
    if (items.length) {
      await tx.insert(bomItems).values(items.map((i) => ({ parentProductId: parentId, componentProductId: i.componentProductId, quantity: String(i.quantity) })));
    }
    const result = await getProduct(tx, parentId);
    await recordAudit(tx, actor, {
      action: "product.bom_replaced",
      entityType: "product",
      entityId: parentId,
      before: { bom: before },
      after: { bom: result.bom.map((b) => ({ componentProductId: b.componentProductId, quantity: b.quantity })) },
    });
    return result;
  });
}

/** Kan `from` via stuklijsten bij `target` uitkomen? */
async function reaches(db: DbOrTx, from: string, target: string): Promise<boolean> {
  const seen = new Set<string>();
  let frontier = [from];
  while (frontier.length) {
    if (frontier.includes(target)) return true;
    frontier.forEach((f) => seen.add(f));
    const children = await db
      .select({ id: bomItems.componentProductId })
      .from(bomItems)
      .where(inArray(bomItems.parentProductId, frontier));
    frontier = [...new Set(children.map((c) => c.id))].filter((id) => !seen.has(id));
  }
  return false;
}

// ---------------------------------------------------------------- Kostprijs (basis voorcalculatie)

export interface CostLine {
  productId: string;
  code: string;
  name: string;
  type: Product["type"];
  quantity: string;
  source: "purchase" | "partner" | null;
  unitCostCents: number | null;
  totalCents: number | null;
}

/**
 * Kostprijs van een product op een datum, op basis van de stuklijst:
 * - arbeid en meerwerk: tarief van de opgegeven installatiepartner
 * - overige componenten: inkoopprijs bij de standaardleverancier
 * Ontbrekende prijzen worden gemeld in plaats van als 0 geteld.
 */
export async function calculateCost(
  db: DbOrTx,
  productId: string,
  opts: { date?: string; partnerOrganizationId?: string } = {},
) {
  const date = opts.date ?? todayIso();
  const product = await getProduct(db, productId);
  const lines: CostLine[] = [];

  for (const item of product.bom) {
    const [component] = await db.select().from(products).where(eq(products.id, item.componentProductId));
    const isLabor = component!.type === "labor" || component!.type === "extra_work";
    let price = null;
    let source: CostLine["source"] = null;
    if (isLabor && opts.partnerOrganizationId) {
      price = await effectivePrice(db, "partner", component!.id, opts.partnerOrganizationId, date);
      source = "partner";
    } else if (!isLabor && component!.defaultSupplierOrganizationId) {
      price = await effectivePrice(db, "purchase", component!.id, component!.defaultSupplierOrganizationId, date);
      source = "purchase";
    }
    lines.push({
      productId: component!.id,
      code: component!.code,
      name: component!.name,
      type: component!.type,
      quantity: item.quantity,
      source,
      unitCostCents: price?.priceCents ?? null,
      totalCents: price ? multiplyCents(price.priceCents, item.quantity) : null,
    });
  }

  const missing = lines.filter((l) => l.totalCents === null).map((l) => l.code);
  return {
    productId,
    date,
    partnerOrganizationId: opts.partnerOrganizationId ?? null,
    lines,
    totalCents: lines.reduce((sum, l) => sum + (l.totalCents ?? 0), 0),
    complete: missing.length === 0,
    missingPrices: missing,
  };
}

/**
 * Kostprijs per eenheid van een product op een datum:
 * - met stuklijst: som van de stuklijst (zie calculateCost)
 * - arbeid/meerwerk zonder stuklijst: tarief van de installatiepartner
 * - overig: inkoopprijs bij de standaardleverancier
 * Null als er een prijs ontbreekt — dan is de marge onbekend, niet "100%".
 */
export async function unitCost(db: DbOrTx, productId: string, date: string, partnerOrganizationId?: string | null): Promise<number | null> {
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  if (!p) return null;
  const [hasBom] = await db.select({ id: bomItems.id }).from(bomItems).where(eq(bomItems.parentProductId, productId)).limit(1);
  if (hasBom) {
    const cost = await calculateCost(db, productId, { date, partnerOrganizationId: partnerOrganizationId ?? undefined });
    return cost.complete ? cost.totalCents : null;
  }
  if (p.type === "labor" || p.type === "extra_work" || p.type === "service") {
    if (!partnerOrganizationId) return null;
    return (await effectivePrice(db, "partner", productId, partnerOrganizationId, date))?.priceCents ?? null;
  }
  if (!p.defaultSupplierOrganizationId) return null;
  return (await effectivePrice(db, "purchase", productId, p.defaultSupplierOrganizationId, date))?.priceCents ?? null;
}
