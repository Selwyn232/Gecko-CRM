import { ownCustomerFilter } from "../specialists/service.js";
import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { users } from "../auth/schema.js";
import { productGroups, salesChannelProductGroups, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { formatCustomerNumber } from "../customers/service.js";
import { emitEvent } from "../events/service.js";
import { journeyStatuses, journeyTransitions } from "../journeys/schema.js";
import { initialStatus, isTransitionAllowed } from "../journeys/service.js";
import { organizations } from "../organizations/schema.js";
import { assertPartnerHandlesGroup } from "../organizations/service.js";
import { projects, projectStatusHistory, type Project } from "./schema.js";

export const formatProjectNumber = (n: number) => `P-${String(n).padStart(6, "0")}`;

export interface ProjectInput {
  customerId: string;
  propertyId: string;
  productGroupId: string;
  salesChannelId: string;
  installationPartnerId?: string | null;
  paymentMethod?: Project["paymentMethod"];
  notes?: string | null;
}

async function assertPartner(tx: DbOrTx, id: string | null | undefined, productGroupId?: string) {
  if (!id) return;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, id));
  if (!org || org.type !== "installation_partner") throw badRequest("invalid_partner", "Organisatie is geen installatiepartner");
  if (productGroupId) await assertPartnerHandlesGroup(tx, id, productGroupId);
}

export async function listProjects(
  db: DbOrTx,
  q: { statusId?: string; productGroupId?: string; phase?: string; partnerId?: string; search?: string; includeFinal?: boolean; limit: number; offset: number },
  actor?: ActorContext,
) {
  const filters: SQL[] = [];
  const own = actor && ownCustomerFilter(actor, projects.customerId);
  if (own) filters.push(own);
  if (q.statusId) filters.push(eq(projects.statusId, q.statusId));
  if (q.productGroupId) filters.push(eq(projects.productGroupId, q.productGroupId));
  if (q.partnerId) filters.push(eq(projects.installationPartnerId, q.partnerId));
  if (q.phase) filters.push(eq(journeyStatuses.phase, q.phase));
  if (!q.includeFinal && !q.statusId) filters.push(eq(journeyStatuses.isFinal, false));
  if (q.search) {
    const like = `%${q.search.trim()}%`;
    const num = q.search.trim().replace(/^[pk]-?/i, "");
    const parts: SQL[] = [
      ilike(customers.lastName, like),
      ilike(customers.firstName, like),
      ilike(properties.postalCode, `%${q.search.replace(/\s/g, "")}%`),
      ilike(properties.city, like),
      ilike(properties.street, like),
    ];
    if (/^\d+$/.test(num)) parts.push(eq(projects.number, Number(num)), eq(customers.number, Number(num)));
    filters.push(or(...parts)!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const base = () =>
    db
      .select({ project: projects, status: journeyStatuses, customer: customers, property: properties })
      .from(projects)
      .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
      .innerJoin(customers, eq(customers.id, projects.customerId))
      .innerJoin(properties, eq(properties.id, projects.propertyId));
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    base().where(where).orderBy(desc(projects.statusChangedAt)).limit(q.limit).offset(q.offset),
    db
      .select({ total: count() })
      .from(projects)
      .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
      .innerJoin(customers, eq(customers.id, projects.customerId))
      .innerJoin(properties, eq(properties.id, projects.propertyId))
      .where(where),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      ...r.project,
      displayNumber: formatProjectNumber(r.project.number),
      status: r.status,
      customer: { id: r.customer.id, displayNumber: formatCustomerNumber(r.customer.number), firstName: r.customer.firstName, lastName: r.customer.lastName },
      property: r.property,
    })),
  };
}

export async function getProject(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ project: projects, status: journeyStatuses, customer: customers, property: properties })
    .from(projects)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .where(eq(projects.id, id));
  if (!row) throw notFound("Project");

  const history = await db
    .select({ entry: projectStatusHistory, byName: users.name })
    .from(projectStatusHistory)
    .leftJoin(users, eq(users.id, projectStatusHistory.changedBy))
    .where(eq(projectStatusHistory.projectId, id))
    .orderBy(desc(projectStatusHistory.changedAt));

  const next = await db
    .select({ status: journeyStatuses })
    .from(journeyTransitions)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, journeyTransitions.toStatusId))
    .where(and(eq(journeyTransitions.fromStatusId, row.project.statusId), eq(journeyStatuses.isActive, true)))
    .orderBy(asc(journeyStatuses.sortOrder));

  return {
    ...row.project,
    displayNumber: formatProjectNumber(row.project.number),
    status: row.status,
    customer: { ...row.customer, displayNumber: formatCustomerNumber(row.customer.number) },
    property: row.property,
    history: history.map((h) => ({ ...h.entry, changedByName: h.byName })),
    nextStatuses: next.map((n) => n.status),
  };
}

export async function createProject(db: Db, actor: ActorContext, input: ProjectInput) {
  return db.transaction((tx) => createProjectInTx(tx, actor, input));
}

/** Zelfde als createProject, maar binnen een bestaande transactie (bv. bij het accepteren van een offerte). */
export async function createProjectInTx(tx: DbOrTx, actor: ActorContext, input: ProjectInput) {
  {
    const [prop] = await tx.select().from(properties).where(eq(properties.id, input.propertyId));
    if (!prop || prop.customerId !== input.customerId) throw badRequest("invalid_property", "Woning hoort niet bij deze klant");
    const [group] = await tx.select().from(productGroups).where(eq(productGroups.id, input.productGroupId));
    if (!group) throw badRequest("unknown_product_group", "Productgroep bestaat niet");
    const [ch] = await tx.select().from(salesChannels).where(eq(salesChannels.id, input.salesChannelId));
    if (!ch) throw badRequest("unknown_sales_channel", "Verkoopkanaal bestaat niet");
    const [allowed] = await tx
      .select()
      .from(salesChannelProductGroups)
      .where(and(eq(salesChannelProductGroups.salesChannelId, ch.id), eq(salesChannelProductGroups.productGroupId, group.id)));
    if (!allowed) throw badRequest("product_group_not_in_channel", "Dit verkoopkanaal verkoopt deze productgroep niet");
    await assertPartner(tx, input.installationPartnerId, input.productGroupId);

    const start = await initialStatus(tx, input.productGroupId, input.salesChannelId);
    const [p] = await tx.insert(projects).values({ ...input, statusId: start.id }).returning();
    await tx.insert(projectStatusHistory).values({ projectId: p!.id, fromStatusId: null, toStatusId: start.id, changedBy: actor.userId });
    await recordAudit(tx, actor, { action: "project.created", entityType: "project", entityId: p!.id, after: p });
    await emitEvent(tx, "project.created", { type: "project", id: p!.id }, { projectId: p!.id, statusKey: start.key, productGroupKey: group.key });
    return getProject(tx, p!.id);
  }
}

export async function updateProject(
  db: Db,
  actor: ActorContext,
  id: string,
  input: Partial<Pick<ProjectInput, "installationPartnerId" | "paymentMethod" | "notes">>,
) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(projects).where(eq(projects.id, id));
    if (!before) throw notFound("Project");
    await assertPartner(tx, input.installationPartnerId, before.productGroupId);
    const [after] = await tx.update(projects).set(input).where(eq(projects.id, id)).returning();
    await recordAudit(tx, actor, { action: "project.updated", entityType: "project", entityId: id, before, after });
    return getProject(tx, id);
  });
}

/**
 * Zet een project in een nieuwe status. Alleen overgangen die in de klantreis zijn toegestaan.
 * `expectedStatusId` voorkomt dat twee medewerkers tegelijk een verouderde status overschrijven.
 */
export async function changeStatus(
  db: Db,
  actor: ActorContext,
  id: string,
  input: { toStatusId: string; expectedStatusId?: string; note?: string | null; /** Alleen voor annuleren: vanuit elke niet-eindstatus. */ allowFromAnyOpen?: boolean },
) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(projects).where(eq(projects.id, id)).for("update");
    if (!p) throw notFound("Project");
    if (input.expectedStatusId && input.expectedStatusId !== p.statusId) {
      throw conflict("status_changed", "De status is intussen door iemand anders gewijzigd; vernieuw de pagina");
    }
    const [to] = await tx.select().from(journeyStatuses).where(eq(journeyStatuses.id, input.toStatusId));
    const [current] = await tx.select().from(journeyStatuses).where(eq(journeyStatuses.id, p.statusId));
    // Alleen statussen uit de klantreis van het project zelf (zelfde productgroep én hetzelfde kanaal, B80).
    if (!to || to.productGroupId !== p.productGroupId || to.salesChannelId !== (current?.salesChannelId ?? null) || !to.isActive) {
      throw badRequest("invalid_status", "Ongeldige status");
    }
    if (!(input.allowFromAnyOpen && !current?.isFinal) && !(await isTransitionAllowed(tx, p.statusId, to.id))) {
      throw badRequest("transition_not_allowed", "Deze statusovergang is niet toegestaan in de klantreis");
    }
    const [from] = await tx.select().from(journeyStatuses).where(eq(journeyStatuses.id, p.statusId));
    const now = new Date();
    await tx.update(projects).set({ statusId: to.id, statusChangedAt: now }).where(eq(projects.id, id));
    await tx.insert(projectStatusHistory).values({
      projectId: id,
      fromStatusId: p.statusId,
      toStatusId: to.id,
      changedBy: actor.userId,
      changedAt: now,
      note: input.note ?? null,
    });
    await recordAudit(tx, actor, {
      action: "project.status_changed",
      entityType: "project",
      entityId: id,
      before: { status: from?.name },
      after: { status: to.name },
      metadata: input.note ? { note: input.note } : undefined,
    });
    await emitEvent(tx, "project.status_changed", { type: "project", id }, { projectId: id, fromStatusKey: from?.key, toStatusKey: to.key, toStatusId: to.id });
    return getProject(tx, id);
  });
}

/** Aantal open projecten per status, voor het overzicht. */
export async function statusCounts(db: DbOrTx, productGroupId?: string, actor?: ActorContext) {
  const own = actor && ownCustomerFilter(actor, projects.customerId);
  return db
    .select({ statusId: projects.statusId, n: count() })
    .from(projects)
    .where(and(productGroupId ? eq(projects.productGroupId, productGroupId) : undefined, own ?? undefined))
    .groupBy(projects.statusId);
}

