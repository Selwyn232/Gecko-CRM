import { and, asc, eq, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { organizations, type Organization } from "./schema.js";

export type OrganizationInput = Omit<typeof organizations.$inferInsert, "id" | "createdAt" | "updatedAt">;

export async function listOrganizations(db: DbOrTx, q: { type?: Organization["type"]; isActive?: boolean }) {
  const filters: SQL[] = [];
  if (q.type) filters.push(eq(organizations.type, q.type));
  if (q.isActive !== undefined) filters.push(eq(organizations.isActive, q.isActive));
  return db
    .select()
    .from(organizations)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(organizations.name));
}

export async function getOrganization(db: DbOrTx, id: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
  if (!org) throw notFound("Organisatie");
  return org;
}

export async function createOrganization(db: Db, actor: ActorContext, input: OrganizationInput) {
  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values(input).returning();
    await recordAudit(tx, actor, { action: "organization.created", entityType: "organization", entityId: org!.id, after: org });
    return org!;
  });
}

export async function updateOrganization(db: Db, actor: ActorContext, id: string, input: Partial<OrganizationInput>) {
  return db.transaction(async (tx) => {
    const before = await getOrganization(tx, id);
    const [after] = await tx.update(organizations).set(input).where(eq(organizations.id, id)).returning();
    await recordAudit(tx, actor, { action: "organization.updated", entityType: "organization", entityId: id, before, after });
    return after!;
  });
}
