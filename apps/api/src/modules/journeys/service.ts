import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups } from "../catalog/schema.js";
import { projects } from "../projects/schema.js";
import { CANCEL_KEY, DEFAULT_JOURNEY } from "./defaults.js";
import { journeyStatuses, journeyTransitions, type JourneyStatus } from "./schema.js";

export type StatusWithTransitions = JourneyStatus & { nextStatusIds: string[]; projectCount: number };

export async function getJourney(db: DbOrTx, productGroupId: string): Promise<StatusWithTransitions[]> {
  const statuses = await db
    .select()
    .from(journeyStatuses)
    .where(eq(journeyStatuses.productGroupId, productGroupId))
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

export async function listJourneys(db: DbOrTx) {
  const groups = await db.select().from(productGroups).orderBy(asc(productGroups.sortOrder));
  return Promise.all(groups.map(async (g) => ({ productGroup: g, statuses: await getJourney(db, g.id) })));
}

/** Maakt de standaard-klantreis aan voor productgroepen zonder statussen. Idempotent. */
export async function ensureDefaultJourneys(tx: DbOrTx) {
  const groups = await tx.select().from(productGroups);
  for (const g of groups) {
    const [existing] = await tx.select({ id: journeyStatuses.id }).from(journeyStatuses).where(eq(journeyStatuses.productGroupId, g.id)).limit(1);
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

async function clearOtherInitial(tx: DbOrTx, productGroupId: string, keepId: string) {
  await tx
    .update(journeyStatuses)
    .set({ isInitial: false })
    .where(and(eq(journeyStatuses.productGroupId, productGroupId), eq(journeyStatuses.isInitial, true)));
  await tx.update(journeyStatuses).set({ isInitial: true }).where(eq(journeyStatuses.id, keepId));
}

export async function createStatus(db: Db, actor: ActorContext, productGroupId: string, input: StatusInput) {
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(productGroups).where(eq(productGroups.id, productGroupId));
    if (!g) throw notFound("Productgroep");
    const [row] = await tx
      .insert(journeyStatuses)
      .values({ ...input, isInitial: false, productGroupId })
      .returning();
    if (input.isInitial) await clearOtherInitial(tx, productGroupId, row!.id);
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
    if (isInitial) await clearOtherInitial(tx, before.productGroupId, id);
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

/** Vervangt de toegestane vervolgstatussen van een status. Alleen statussen binnen dezelfde productgroep. */
export async function setTransitions(db: Db, actor: ActorContext, fromId: string, toIds: string[]) {
  return db.transaction(async (tx) => {
    const from = await getStatus(tx, fromId);
    const unique = [...new Set(toIds)].filter((x) => x !== fromId);
    if (unique.length) {
      const targets = await tx.select().from(journeyStatuses).where(inArray(journeyStatuses.id, unique));
      if (targets.length !== unique.length || targets.some((t) => t.productGroupId !== from.productGroupId)) {
        throw badRequest("invalid_transition", "Vervolgstatussen moeten bij dezelfde productgroep horen");
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

export async function initialStatus(db: DbOrTx, productGroupId: string) {
  const [s] = await db
    .select()
    .from(journeyStatuses)
    .where(and(eq(journeyStatuses.productGroupId, productGroupId), eq(journeyStatuses.isInitial, true)));
  if (!s) throw badRequest("no_initial_status", "Deze productgroep heeft nog geen startstatus in de klantreis");
  return s;
}

export async function isTransitionAllowed(db: DbOrTx, fromId: string, toId: string) {
  const [t] = await db
    .select()
    .from(journeyTransitions)
    .where(and(eq(journeyTransitions.fromStatusId, fromId), eq(journeyTransitions.toStatusId, toId)));
  return !!t;
}
