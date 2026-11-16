import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { loadPermissions } from "../auth/access.js";
import type { Permission } from "../auth/permissions.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { organizations } from "../organizations/schema.js";
import { projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { notifications, tasks } from "./schema.js";

// ---------------------------------------------------------------- Meldingen

/** Melding naar één gebruiker. */
export async function notify(db: DbOrTx, userId: string, n: { title: string; body?: string | null; href?: string | null; dedupeKey?: string }) {
  await db.insert(notifications).values({ userId, title: n.title, body: n.body ?? null, href: n.href ?? null, dedupeKey: n.dedupeKey ?? null }).onConflictDoNothing();
}

/** Melding naar alle actieve Gecko-medewerkers met een recht (bv. iedereen die rapporten beoordeelt). */
export async function notifyPermission(db: DbOrTx, permission: Permission, n: { title: string; body?: string | null; href?: string | null; dedupeKey?: string }) {
  const staff = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(and(eq(users.isActive, true), eq(organizations.type, "gecko")));
  for (const u of staff) {
    if ((await loadPermissions(db, u.id)).has(permission)) await notify(db, u.id, n);
  }
}

export async function listNotifications(db: DbOrTx, userId: string) {
  const items = await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(30);
  const [{ unread }] = (await db.select({ unread: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))) as [{ unread: number }];
  return { unread, items };
}

export async function markRead(db: DbOrTx, userId: string, id: string | "all") {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), id === "all" ? undefined : eq(notifications.id, id)));
}

// ---------------------------------------------------------------- Taken

export async function listTasks(db: DbOrTx, q: { assigneeUserId?: string; customerId?: string; projectId?: string; open?: boolean }) {
  const filters = [];
  if (q.assigneeUserId) filters.push(eq(tasks.assigneeUserId, q.assigneeUserId));
  if (q.customerId) filters.push(eq(tasks.customerId, q.customerId));
  if (q.projectId) filters.push(eq(tasks.projectId, q.projectId));
  if (q.open) filters.push(isNull(tasks.doneAt));
  const rows = await db
    .select({ t: tasks, assignee: users.name, customerFirst: customers.firstName, customerLast: customers.lastName, projectNumber: projects.number })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeUserId))
    .leftJoin(customers, eq(customers.id, tasks.customerId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(sql`${tasks.doneAt} IS NOT NULL`, asc(sql`coalesce(${tasks.dueDate}, '9999-12-31')`), desc(tasks.createdAt))
    .limit(200);
  return rows.map((r) => ({
    ...r.t,
    assigneeName: r.assignee,
    customerName: r.customerLast ? [r.customerFirst, r.customerLast].filter(Boolean).join(" ") : null,
    projectNumber: r.projectNumber ? formatProjectNumber(r.projectNumber) : null,
  }));
}

async function assertRefs(db: DbOrTx, input: { customerId?: string | null; projectId?: string | null; assigneeUserId?: string | null }) {
  if (input.projectId) {
    const [p] = await db.select().from(projects).where(eq(projects.id, input.projectId));
    if (!p) throw notFound("Project");
    if (input.customerId && p.customerId !== input.customerId) throw badRequest("invalid_project", "Project hoort niet bij deze klant");
    input.customerId = p.customerId;
  }
  if (input.assigneeUserId) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(and(eq(users.id, input.assigneeUserId), eq(users.isActive, true), eq(organizations.type, "gecko")));
    if (!u) throw badRequest("invalid_assignee", "Taak kan alleen aan een actieve medewerker worden toegewezen");
  }
}

export async function createTask(
  db: DbOrTx,
  actor: ActorContext,
  input: { title: string; description?: string | null; customerId?: string | null; projectId?: string | null; assigneeUserId?: string | null; dueDate?: string | null },
) {
  await assertRefs(db, input);
  const [t] = await db
    .insert(tasks)
    .values({ ...input, assigneeUserId: input.assigneeUserId ?? actor.userId, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, { action: "task.created", entityType: "task", entityId: t!.id, after: { title: t!.title, assignee: t!.assigneeUserId, due: t!.dueDate } });
  if (t!.assigneeUserId && t!.assigneeUserId !== actor.userId) {
    await notify(db, t!.assigneeUserId, { title: `Nieuwe taak: ${t!.title}`, body: t!.dueDate ? `Deadline ${t!.dueDate}` : null, href: t!.customerId ? `/klanten/${t!.customerId}` : "/werk" });
  }
  return t!;
}

export async function updateTask(db: DbOrTx, actor: ActorContext, id: string, input: { title?: string; description?: string | null; assigneeUserId?: string | null; dueDate?: string | null; done?: boolean }) {
  const [before] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!before) throw notFound("Taak");
  await assertRefs(db, { assigneeUserId: input.assigneeUserId });
  const { done, ...rest } = input;
  const patch: Partial<typeof tasks.$inferInsert> = { ...rest };
  if (done !== undefined) {
    patch.doneAt = done ? new Date() : null;
    patch.doneBy = done ? actor.userId : null;
  }
  const [t] = await db.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
  await recordAudit(db, actor, { action: "task.updated", entityType: "task", entityId: id, before: { title: before.title, done: !!before.doneAt, assignee: before.assigneeUserId }, after: { title: t!.title, done: !!t!.doneAt, assignee: t!.assigneeUserId } });
  if (input.assigneeUserId && input.assigneeUserId !== before.assigneeUserId && input.assigneeUserId !== actor.userId) {
    await notify(db, input.assigneeUserId, { title: `Taak voor jou: ${t!.title}`, href: t!.customerId ? `/klanten/${t!.customerId}` : "/werk" });
  }
  return t!;
}

/** Open taken van een gebruiker tot en met een datum (voor "Mijn werk"). */
export async function dueTasks(db: DbOrTx, userId: string, until: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.assigneeUserId, userId), isNull(tasks.doneAt), or(isNull(tasks.dueDate), lte(tasks.dueDate, until))))
    .orderBy(asc(sql`coalesce(${tasks.dueDate}, '9999-12-31')`));
}


