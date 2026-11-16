import { and, asc, eq, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { advisors, organizations, type Organization } from "./schema.js";

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

// ---------------------------------------------------------------- Adviseurs

export type AdvisorInput = { organizationId: string; name: string; email?: string | null; phone?: string | null; isActive?: boolean };

export const listAdvisors = (db: DbOrTx, organizationId?: string) =>
  db.select().from(advisors).where(organizationId ? eq(advisors.organizationId, organizationId) : undefined).orderBy(asc(advisors.name));

export async function createAdvisor(db: Db, actor: ActorContext, input: AdvisorInput) {
  return db.transaction(async (tx) => {
    const org = await getOrganization(tx, input.organizationId);
    if (org.type !== "sales_partner") throw badRequest("not_sales_partner", "Adviseurs horen bij een verkooppartner");
    const [row] = await tx.insert(advisors).values({ ...input, email: input.email?.trim().toLowerCase() || null }).returning();
    await recordAudit(tx, actor, { action: "advisor.created", entityType: "organization", entityId: input.organizationId, after: row });
    return row!;
  });
}

export async function updateAdvisor(db: Db, actor: ActorContext, id: string, input: Partial<Omit<AdvisorInput, "organizationId">>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(advisors).where(eq(advisors.id, id));
    if (!before) throw notFound("Adviseur");
    const [after] = await tx.update(advisors).set(input).where(eq(advisors.id, id)).returning();
    await recordAudit(tx, actor, { action: "advisor.updated", entityType: "organization", entityId: before.organizationId, before, after });
    return after!;
  });
}
