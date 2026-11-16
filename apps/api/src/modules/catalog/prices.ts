import { and, desc, eq, lte } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { organizations } from "../organizations/schema.js";
import {
  partnerRates,
  products,
  purchasePrices,
  salesChannelProductGroups,
  salesChannels,
  salesPrices,
} from "./schema.js";

/**
 * Drie soorten prijsversies met dezelfde regels:
 * - sales:    verkoopprijs per verkoopkanaal
 * - purchase: inkoopprijs per leverancier
 * - partner:  vast tarief per installatiepartner
 */
export type PriceKind = "sales" | "purchase" | "partner";

const tables = {
  sales: { table: salesPrices, scope: salesPrices.salesChannelId, scopeKey: "salesChannelId" },
  purchase: { table: purchasePrices, scope: purchasePrices.supplierOrganizationId, scopeKey: "supplierOrganizationId" },
  partner: { table: partnerRates, scope: partnerRates.partnerOrganizationId, scopeKey: "partnerOrganizationId" },
} as const;

export interface PriceVersion {
  id: string;
  productId: string;
  scopeId: string;
  priceCents: number;
  validFrom: string;
  createdAt: Date;
  createdBy: string | null;
}

function toVersion(kind: PriceKind, row: Record<string, unknown>): PriceVersion {
  return {
    id: row.id as string,
    productId: row.productId as string,
    scopeId: row[tables[kind].scopeKey] as string,
    priceCents: row.priceCents as number,
    validFrom: row.validFrom as string,
    createdAt: row.createdAt as Date,
    createdBy: (row.createdBy as string | null) ?? null,
  };
}

async function assertScopeValid(db: DbOrTx, kind: PriceKind, productId: string, scopeId: string) {
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) throw notFound("Product");

  if (kind === "sales") {
    const [channel] = await db.select().from(salesChannels).where(eq(salesChannels.id, scopeId));
    if (!channel) throw badRequest("unknown_sales_channel", "Verkoopkanaal bestaat niet");
    const [allowed] = await db
      .select()
      .from(salesChannelProductGroups)
      .where(
        and(
          eq(salesChannelProductGroups.salesChannelId, scopeId),
          eq(salesChannelProductGroups.productGroupId, product.productGroupId),
        ),
      );
    if (!allowed) {
      throw badRequest("product_group_not_in_channel", "Dit verkoopkanaal verkoopt deze productgroep niet");
    }
    return;
  }

  const expectedType = kind === "purchase" ? "supplier" : "installation_partner";
  const [org] = await db.select().from(organizations).where(eq(organizations.id, scopeId));
  if (!org || org.type !== expectedType) {
    throw badRequest(
      "invalid_scope_organization",
      kind === "purchase" ? "Organisatie is geen leverancier" : "Organisatie is geen installatiepartner",
    );
  }
}

export async function listPriceVersions(db: DbOrTx, kind: PriceKind, productId: string, scopeId?: string) {
  const { table, scope } = tables[kind];
  const rows = await db
    .select()
    .from(table)
    .where(scopeId ? and(eq(table.productId, productId), eq(scope, scopeId)) : eq(table.productId, productId))
    .orderBy(desc(table.validFrom));
  return rows.map((r) => toVersion(kind, r));
}

/**
 * Voegt een nieuwe prijsversie toe. Een ingangsdatum in het verleden is niet toegestaan:
 * dat zou historische offertes en calculaties achteraf veranderen.
 */
export async function addPriceVersion(
  db: Db,
  actor: ActorContext,
  kind: PriceKind,
  input: { productId: string; scopeId: string; priceCents: number; validFrom: string },
) {
  if (input.validFrom < todayIso()) {
    throw badRequest("valid_from_in_past", "Ingangsdatum mag niet in het verleden liggen");
  }
  return db.transaction(async (tx) => {
    await assertScopeValid(tx, kind, input.productId, input.scopeId);
    const { table, scopeKey } = tables[kind];
    const [row] = await tx
      .insert(table)
      .values({
        productId: input.productId,
        priceCents: input.priceCents,
        validFrom: input.validFrom,
        createdBy: actor.userId,
        [scopeKey]: input.scopeId,
        // De scope-kolom verschilt per tabel; TypeScript kan die dynamische sleutel niet volgen.
      } as never)
      .returning();
    const version = toVersion(kind, row!);
    await recordAudit(tx, actor, {
      action: `price.${kind}.created`,
      entityType: "product",
      entityId: input.productId,
      after: { ...version },
    });
    return version;
  });
}

/** Alleen prijsversies die nog niet zijn ingegaan mogen worden verwijderd. */
export async function deletePriceVersion(db: Db, actor: ActorContext, kind: PriceKind, id: string) {
  await db.transaction(async (tx) => {
    const { table } = tables[kind];
    const [row] = await tx.select().from(table).where(eq(table.id, id));
    if (!row) throw notFound("Prijsversie");
    const version = toVersion(kind, row);
    if (version.validFrom <= todayIso()) {
      throw badRequest("price_already_effective", "Een prijs die al is ingegaan kan niet worden verwijderd");
    }
    await tx.delete(table).where(eq(table.id, id));
    await recordAudit(tx, actor, {
      action: `price.${kind}.deleted`,
      entityType: "product",
      entityId: version.productId,
      before: { ...version },
    });
  });
}

/** De geldende prijs op een datum, of null als er (nog) geen prijs is. */
export async function effectivePrice(
  db: DbOrTx,
  kind: PriceKind,
  productId: string,
  scopeId: string,
  date: string = todayIso(),
): Promise<PriceVersion | null> {
  const { table, scope } = tables[kind];
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.productId, productId), eq(scope, scopeId), lte(table.validFrom, date)))
    .orderBy(desc(table.validFrom))
    .limit(1);
  return row ? toVersion(kind, row) : null;
}
