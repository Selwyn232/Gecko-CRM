import { and, asc, count, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups, salesChannelProductGroups, salesChannels } from "../catalog/schema.js";
import { messageTemplates } from "../messages/schema.js";
import { projectStatusHistory, projects } from "../projects/schema.js";
import { CANCEL_KEY, DEFAULT_JOURNEY } from "./defaults.js";
import { journeyStatuses, journeyTransitions, type JourneyStatus } from "./schema.js";

export type StatusWithTransitions = JourneyStatus & { nextStatusIds: string[]; projectCount: number };

/** Filter op één klantreis: productgroep + verkoopkanaal (leeg = standaardklantreis). */
export const inJourney = (productGroupId: string, salesChannelId: string | null): SQL =>
  and(eq(journeyStatuses.productGroupId, productGroupId), salesChannelId ? eq(journeyStatuses.salesChannelId, salesChannelId) : isNull(journeyStatuses.salesChannelId))!;

/** Welke klantreis geldt voor een project van dit kanaal: de eigen klantreis van het kanaal als die er is, anders de standaard. */
export async function journeyChannelFor(db: DbOrTx, productGroupId: string, salesChannelId: string | null | undefined) {
  if (!salesChannelId) return null;
  const [own] = await db.select({ id: journeyStatuses.id }).from(journeyStatuses).where(inJourney(productGroupId, salesChannelId)).limit(1);
  return own ? salesChannelId : null;
}

/** Status met deze sleutel in dezelfde klantreis als een andere status (bv. "geannuleerd" voor een project). */
export async function statusByKeyInJourneyOf(db: DbOrTx, statusId: string, key: string) {
  const [ref] = await db.select().from(journeyStatuses).where(eq(journeyStatuses.id, statusId));
  if (!ref) return undefined;
  const [s] = await db.select().from(journeyStatuses).where(and(inJourney(ref.productGroupId, ref.salesChannelId), eq(journeyStatuses.key, key)));
  return s;
}

export async function getJourney(db: DbOrTx, productGroupId: string, salesChannelId: string | null = null): Promise<StatusWithTransitions[]> {
  const statuses = await db
    .select()
    .from(journeyStatuses)
    .where(inJourney(productGroupId, salesChannelId))
    .orderBy(asc(journeyStatuses.sortOrder), asc(journeyStatuses.name));
  if (!statuses.length) return [];
  const ids = statuses.map((s) => s.id);
  const transitions = await db.select().from(journeyTransitions).where(inArray(journeyTransitions.fromStatusId, ids));
  const counts = await db
    .select({ statusId: projects.statusId, n: count() })
    .from(projects)
    .where(inArray(projects.statusId, ids))
    .groupBy(projects.statusId);
  return statuses.map((s) => ({
    ...s,
    nextStatusIds: transitions.filter((t) => t.fromStatusId === s.id).map((t) => t.toStatusId),
    projectCount: counts.find((c) => c.statusId === s.id)?.n ?? 0,
  }));
}

/**
 * Alle klantreizen: per productgroep de standaardklantreis, plus de eigen klantreizen van verkoopkanalen.
 * `channels` = de actieve kanalen die deze productgroep verkopen (om een eigen klantreis voor te maken).
 */
export async function listJourneys(db: DbOrTx) {
  const groups = await db.select().from(productGroups).orderBy(asc(productGroups.sortOrder));
  const channelLinks = await db
    .select({ productGroupId: salesChannelProductGroups.productGroupId, id: salesChannels.id, name: salesChannels.name })
    .from(salesChannelProductGroups)
    .innerJoin(salesChannels, eq(salesChannels.id, salesChannelProductGroups.salesChannelId))
    .where(eq(salesChannels.isActive, true))
    .orderBy(asc(salesChannels.name));
  const own = await db
    .selectDistinct({ productGroupId: journeyStatuses.productGroupId, salesChannelId: journeyStatuses.salesChannelId })
    .from(journeyStatuses);
  const allChannels = await db.select({ id: salesChannels.id, name: salesChannels.name }).from(salesChannels);
  const result = [];
  for (const g of groups) {
    const channels = channelLinks.filter((c) => c.productGroupId === g.id).map(({ id, name }) => ({ id, name }));
    result.push({ productGroup: g, salesChannel: null as { id: string; name: string } | null, channels, statuses: await getJourney(db, g.id, null) });
    for (const o of own.filter((x) => x.productGroupId === g.id && x.salesChannelId)) {
      const ch = allChannels.find((c) => c.id === o.salesChannelId)!;
      result.push({ productGroup: g, salesChannel: ch, channels, statuses: await getJourney(db, g.id, ch.id) });
    }
  }
  return result;
}

/** Maakt de standaard-klantreis aan voor productgroepen zonder statussen. Idempotent. */
export async function ensureDefaultJourneys(tx: DbOrTx) {
  const groups = await tx.select().from(productGroups);
  for (const g of groups) {
    const [existing] = await tx.select({ id: journeyStatuses.id }).from(journeyStatuses).where(inJourney(g.id, null)).limit(1);
    if (existing) continue;
    const created = await tx
      .insert(journeyStatuses)
      .values(
        DEFAULT_JOURNEY.map((s, i) => ({
          productGroupId: g.id,
          key: s.key,
          name: s.name,
          phase: s.phase,
          color: s.color,
          sortOrder: (i + 1) * 10,
          isInitial: s.isInitial ?? false,
          isFinal: s.isFinal ?? false,
          invoiceTrigger: s.invoiceTrigger ?? null,
          autoOnEvents: s.autoOnEvents ?? [],
        })),
      )
      .returning();
    const byKey = new Map(created.map((c) => [c.key, c.id]));
    const transitions = DEFAULT_JOURNEY.flatMap((s) => {
      const next = [...s.next, ...(s.isFinal ? [] : [CANCEL_KEY])];
      return next.map((n) => ({ fromStatusId: byKey.get(s.key)!, toStatusId: byKey.get(n)! }));
    });
    await tx.insert(journeyTransitions).values(transitions);
  }
}

export interface StatusInput {
  key: string;
  name: string;
  phase: string;
  color?: string;
  sortOrder?: number;
  isInitial?: boolean;
  isFinal?: boolean;
  isActive?: boolean;
  invoiceTrigger?: "deposit" | "final" | null;
  autoOnEvents?: string[];
}

async function getStatus(db: DbOrTx, id: string) {
  const [s] = await db.select().from(journeyStatuses).where(eq(journeyStatuses.id, id));
  if (!s) throw notFound("Status");
  return s;
}

async function clearOtherInitial(tx: DbOrTx, productGroupId: string, salesChannelId: string | null, keepId: string) {
  await tx
    .update(journeyStatuses)
    .set({ isInitial: false })
    .where(and(inJourney(productGroupId, salesChannelId), eq(journeyStatuses.isInitial, true)));
  await tx.update(journeyStatuses).set({ isInitial: true }).where(eq(journeyStatuses.id, keepId));
}

export async function createStatus(db: Db, actor: ActorContext, productGroupId: string, input: StatusInput, salesChannelId: string | null = null) {
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(productGroups).where(eq(productGroups.id, productGroupId));
    if (!g) throw notFound("Productgroep");
    if (salesChannelId) {
      const [own] = await tx.select({ id: journeyStatuses.id }).from(journeyStatuses).where(inJourney(productGroupId, salesChannelId)).limit(1);
      if (!own) throw badRequest("no_channel_journey", "Maak eerst een eigen klantreis voor dit verkoopkanaal");
    }
    const [dup] = await tx.select({ id: journeyStatuses.id }).from(journeyStatuses).where(and(inJourney(productGroupId, salesChannelId), eq(journeyStatuses.key, input.key)));
    if (dup) throw conflict("status_key_exists", "Deze sleutel bestaat al in deze klantreis");
    const [row] = await tx
      .insert(journeyStatuses)
      .values({ ...input, isInitial: false, productGroupId, salesChannelId })
      .returning();
    if (input.isInitial) await clearOtherInitial(tx, productGroupId, salesChannelId, row!.id);
    const after = await getStatus(tx, row!.id);
    await recordAudit(tx, actor, { action: "journey_status.created", entityType: "journey_status", entityId: row!.id, after });
    return after;
  });
}

export async function updateStatus(db: Db, actor: ActorContext, id: string, input: Partial<Omit<StatusInput, "key">>) {
  return db.transaction(async (tx) => {
    const before = await getStatus(tx, id);
    if (input.isInitial === false && before.isInitial) {
      throw badRequest("initial_required", "Wijs eerst een andere status aan als startstatus");
    }
    if (input.isActive === false && before.isInitial) {
      throw badRequest("initial_required", "De startstatus kan niet worden gedeactiveerd");
    }
    const { isInitial, ...rest } = input;
    if (Object.keys(rest).length) await tx.update(journeyStatuses).set(rest).where(eq(journeyStatuses.id, id));
    if (isInitial) await clearOtherInitial(tx, before.productGroupId, before.salesChannelId, id);
    const after = await getStatus(tx, id);
    await recordAudit(tx, actor, { action: "journey_status.updated", entityType: "journey_status", entityId: id, before, after });
    return after;
  });
}

/** Statussen in gebruik kunnen niet worden verwijderd (wel gedeactiveerd), zodat historie klopt. */
export async function deleteStatus(db: Db, actor: ActorContext, id: string) {
  await db.transaction(async (tx) => {
    const before = await getStatus(tx, id);
    if (before.isInitial) throw badRequest("initial_required", "De startstatus kan niet worden verwijderd");
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(projects).where(eq(projects.statusId, id));
    if (n > 0) throw conflict("status_in_use", `Status is in gebruik door ${n} project(en); deactiveer hem in plaats daarvan`);
    await tx.delete(journeyStatuses).where(eq(journeyStatuses.id, id));
    await recordAudit(tx, actor, { action: "journey_status.deleted", entityType: "journey_status", entityId: id, before });
  });
}

/** Vervangt de toegestane vervolgstatussen van een status. Alleen statussen binnen dezelfde klantreis. */
export async function setTransitions(db: Db, actor: ActorContext, fromId: string, toIds: string[]) {
  return db.transaction(async (tx) => {
    const from = await getStatus(tx, fromId);
    const unique = [...new Set(toIds)].filter((x) => x !== fromId);
    if (unique.length) {
      const targets = await tx.select().from(journeyStatuses).where(inArray(journeyStatuses.id, unique));
      if (targets.length !== unique.length || targets.some((t) => t.productGroupId !== from.productGroupId || t.salesChannelId !== from.salesChannelId)) {
        throw badRequest("invalid_transition", "Vervolgstatussen moeten bij dezelfde klantreis horen");
      }
    }
    const before = (await tx.select().from(journeyTransitions).where(eq(journeyTransitions.fromStatusId, fromId))).map((t) => t.toStatusId).sort();
    await tx.delete(journeyTransitions).where(eq(journeyTransitions.fromStatusId, fromId));
    if (unique.length) await tx.insert(journeyTransitions).values(unique.map((toStatusId) => ({ fromStatusId: fromId, toStatusId })));
    await recordAudit(tx, actor, {
      action: "journey_status.transitions_set",
      entityType: "journey_status",
      entityId: fromId,
      before: { next: before },
      after: { next: unique.sort() },
    });
    return unique;
  });
}

/** Startstatus voor een nieuw project: uit de eigen klantreis van het kanaal, anders de standaard. */
export async function initialStatus(db: DbOrTx, productGroupId: string, salesChannelId: string | null = null) {
  const channel = await journeyChannelFor(db, productGroupId, salesChannelId);
  const [s] = await db
    .select()
    .from(journeyStatuses)
    .where(and(inJourney(productGroupId, channel), eq(journeyStatuses.isInitial, true)));
  if (!s) throw badRequest("no_initial_status", "Deze klantreis heeft nog geen startstatus");
  return s;
}

/**
 * Eigen klantreis voor een verkoopkanaal maken: een kopie van de standaardklantreis van de productgroep
 * (statussen, overgangen, automatische wissels, factuurmomenten en klantberichten). Daarna los aan te passen.
 * Geldt voor nieuwe projecten van dat kanaal; lopende projecten houden hun klantreis.
 */
export async function createChannelJourney(db: Db, actor: ActorContext, productGroupId: string, salesChannelId: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(salesChannelProductGroups)
      .where(and(eq(salesChannelProductGroups.salesChannelId, salesChannelId), eq(salesChannelProductGroups.productGroupId, productGroupId)));
    if (!link) throw badRequest("product_group_not_in_channel", "Dit verkoopkanaal verkoopt deze productgroep niet");
    const [exists] = await tx.select({ id: journeyStatuses.id }).from(journeyStatuses).where(inJourney(productGroupId, salesChannelId)).limit(1);
    if (exists) throw conflict("channel_journey_exists", "Dit verkoopkanaal heeft al een eigen klantreis voor deze productgroep");
    const source = await tx.select().from(journeyStatuses).where(inJourney(productGroupId, null)).orderBy(asc(journeyStatuses.sortOrder));
    if (!source.length) throw badRequest("no_standard_journey", "De standaardklantreis van deze productgroep is leeg");
    const idMap = new Map<string, string>();
    for (const st of source) {
      const { id: oldId, createdAt: _c, updatedAt: _u, ...rest } = st;
      const [row] = await tx.insert(journeyStatuses).values({ ...rest, salesChannelId }).returning({ id: journeyStatuses.id });
      idMap.set(oldId, row!.id);
    }
    const transitions = await tx.select().from(journeyTransitions).where(inArray(journeyTransitions.fromStatusId, [...idMap.keys()]));
    const copies = transitions
      .filter((t) => idMap.has(t.toStatusId))
      .map((t) => ({ fromStatusId: idMap.get(t.fromStatusId)!, toStatusId: idMap.get(t.toStatusId)! }));
    if (copies.length) await tx.insert(journeyTransitions).values(copies);
    const templates = await tx.select().from(messageTemplates).where(inArray(messageTemplates.journeyStatusId, [...idMap.keys()]));
    if (templates.length) {
      await tx.insert(messageTemplates).values(
        templates.map(({ id: _id, createdAt: _c, updatedAt: _u, journeyStatusId, ...t }) => ({ ...t, journeyStatusId: idMap.get(journeyStatusId!)! })),
      );
    }
    await recordAudit(tx, actor, {
      action: "journey.channel_created",
      entityType: "product_group",
      entityId: productGroupId,
      metadata: { salesChannelId, statuses: source.length, transitions: copies.length, messages: templates.length },
    });
    return getJourney(tx, productGroupId, salesChannelId);
  });
}

/** Eigen klantreis van een kanaal verwijderen (terug naar de standaard). Alleen als geen enkel project hem gebruikt. */
export async function deleteChannelJourney(db: Db, actor: ActorContext, productGroupId: string, salesChannelId: string) {
  await db.transaction(async (tx) => {
    const statuses = await tx.select({ id: journeyStatuses.id }).from(journeyStatuses).where(inJourney(productGroupId, salesChannelId));
    if (!statuses.length) throw notFound("Klantreis");
    const ids = statuses.map((x) => x.id);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(projects).where(inArray(projects.statusId, ids));
    if (n > 0) throw conflict("journey_in_use", `Deze klantreis wordt gebruikt door ${n} project(en) en kan niet worden verwijderd`);
    const [{ h } = { h: 0 }] = await tx
      .select({ h: count() })
      .from(projectStatusHistory)
      .where(inArray(projectStatusHistory.toStatusId, ids));
    if (h > 0) throw conflict("journey_in_use", "Deze klantreis is al door projecten gebruikt (historie) en kan niet worden verwijderd; pas hem aan in plaats daarvan");
    await tx.delete(journeyStatuses).where(inArray(journeyStatuses.id, ids));
    await recordAudit(tx, actor, { action: "journey.channel_deleted", entityType: "product_group", entityId: productGroupId, metadata: { salesChannelId } });
  });
}

export async function isTransitionAllowed(db: DbOrTx, fromId: string, toId: string) {
  const [t] = await db
    .select()
    .from(journeyTransitions)
    .where(and(eq(journeyTransitions.fromStatusId, fromId), eq(journeyTransitions.toStatusId, toId)));
  return !!t;
}
