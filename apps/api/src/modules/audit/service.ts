import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { diff } from "../../lib/diff.js";
import { auditLog } from "./schema.js";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/**
 * Schrijf een logregel. Roep dit aan binnen dezelfde transactie als de wijziging zelf,
 * zodat er nooit een wijziging zonder logregel bestaat (of andersom).
 */
export async function recordAudit(db: DbOrTx, actor: ActorContext, input: AuditInput) {
  const changes = input.before !== undefined || input.after !== undefined
    ? diff(input.before ?? null, input.after ?? null)
    : null;
  await db.insert(auditLog).values({
    actorUserId: actor.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    changes,
    metadata: actor.impersonatorUserId ? { ...(input.metadata ?? {}), impersonatorUserId: actor.impersonatorUserId } : (input.metadata ?? null),
    requestId: actor.requestId ?? null,
    ip: actor.ip ?? null,
  });
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  /** Cursor: geef regels ouder dan dit id. */
  before?: number;
  limit: number;
}

export async function listAudit(db: DbOrTx, q: AuditQuery) {
  const filters: SQL[] = [];
  if (q.entityType) filters.push(eq(auditLog.entityType, q.entityType));
  if (q.entityId) filters.push(eq(auditLog.entityId, q.entityId));
  if (q.actorUserId) filters.push(eq(auditLog.actorUserId, q.actorUserId));
  if (q.before) filters.push(lt(auditLog.id, q.before));
  const rows = await db
    .select()
    .from(auditLog)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(q.limit);
  return { items: rows, nextCursor: rows.length === q.limit ? rows[rows.length - 1]!.id : null };
}
