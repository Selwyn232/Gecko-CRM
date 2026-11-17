import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { roles, users } from "../auth/schema.js";
import { productGroups } from "../catalog/schema.js";
import type { EmailTransport } from "../email/transport.js";
import { partnerProductGroups } from "../planning/schema.js";
import { sendInvite } from "../users/invites.js";
import { createUser } from "../users/service.js";
import { advisors, organizations, type Organization } from "./schema.js";

export type OrganizationInput = Omit<typeof organizations.$inferInsert, "id" | "createdAt" | "updatedAt">;
/** Contactpersoon die het account van een installatiepartner krijgt. */
export interface PartnerAccountInput {
  name: string;
  email: string;
}

/** Productgroepen per partner (leeg = nog niet ingesteld = alle productgroepen). */
async function groupsByPartner(db: DbOrTx, ids: string[]) {
  if (!ids.length) return new Map<string, string[]>();
  const rows = await db.select().from(partnerProductGroups).where(inArray(partnerProductGroups.partnerOrganizationId, ids));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.partnerOrganizationId, [...(map.get(r.partnerOrganizationId) ?? []), r.productGroupId]);
  return map;
}

/** Aantal actieve gebruikers per organisatie (om partners zonder account te tonen). */
async function userCounts(db: DbOrTx, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db
    .select({ id: users.organizationId, n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(inArray(users.organizationId, ids), eq(users.isActive, true)))
    .groupBy(users.organizationId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

async function withExtras<T extends Organization>(db: DbOrTx, orgs: T[]) {
  const ids = orgs.map((o) => o.id);
  const [groups, counts] = await Promise.all([groupsByPartner(db, ids), userCounts(db, ids)]);
  return orgs.map((o) => ({ ...o, productGroupIds: (groups.get(o.id) ?? []).sort(), userCount: counts.get(o.id) ?? 0 }));
}

export async function listOrganizations(db: DbOrTx, q: { type?: Organization["type"]; isActive?: boolean }) {
  const filters: SQL[] = [];
  if (q.type) filters.push(eq(organizations.type, q.type));
  if (q.isActive !== undefined) filters.push(eq(organizations.isActive, q.isActive));
  const rows = await db
    .select()
    .from(organizations)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(organizations.name));
  return withExtras(db, rows);
}

export async function getOrganization(db: DbOrTx, id: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
  if (!org) throw notFound("Organisatie");
  return (await withExtras(db, [org]))[0]!;
}

/**
 * Installeert deze partner deze productgroep? Partners zonder ingestelde productgroepen doen alles
 * (bestaande partners blijven werken tot het is ingesteld).
 */
export async function partnerHandlesGroup(db: DbOrTx, partnerId: string, productGroupId: string) {
  const rows = await db.select().from(partnerProductGroups).where(eq(partnerProductGroups.partnerOrganizationId, partnerId));
  return !rows.length || rows.some((r) => r.productGroupId === productGroupId);
}

/** Fout als de partner deze productgroep niet installeert. */
export async function assertPartnerHandlesGroup(db: DbOrTx, partnerId: string, productGroupId: string) {
  if (await partnerHandlesGroup(db, partnerId, productGroupId)) return;
  const [p] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, partnerId));
  const [g] = await db.select({ name: productGroups.name }).from(productGroups).where(eq(productGroups.id, productGroupId));
  throw badRequest("partner_wrong_group", `${p?.name ?? "Deze partner"} installeert geen ${(g?.name ?? "producten uit deze groep").toLowerCase()}`);
}

async function setPartnerGroups(tx: DbOrTx, actor: ActorContext, partnerId: string, productGroupIds: string[]) {
  const ids = [...new Set(productGroupIds)];
  if (ids.length) {
    const found = await tx.select({ id: productGroups.id }).from(productGroups).where(inArray(productGroups.id, ids));
    if (found.length !== ids.length) throw badRequest("unknown_product_group", "Onbekende productgroep");
  }
  const before = (await tx.select().from(partnerProductGroups).where(eq(partnerProductGroups.partnerOrganizationId, partnerId))).map((r) => r.productGroupId).sort();
  await tx.delete(partnerProductGroups).where(eq(partnerProductGroups.partnerOrganizationId, partnerId));
  if (ids.length) await tx.insert(partnerProductGroups).values(ids.map((productGroupId) => ({ partnerOrganizationId: partnerId, productGroupId })));
  await recordAudit(tx, actor, { action: "organization.product_groups_set", entityType: "organization", entityId: partnerId, before: { productGroupIds: before }, after: { productGroupIds: ids.sort() } });
}

/** Gebruiker met rol Installatiepartner (zonder bruikbaar wachtwoord; dat stelt de partner zelf in via de uitnodiging). */
async function createPartnerUser(tx: DbOrTx, actor: ActorContext, partnerId: string, account: PartnerAccountInput) {
  const [role] = await tx.select().from(roles).where(eq(roles.key, "installatiepartner"));
  if (!role) throw badRequest("no_partner_role", "Rol 'installatiepartner' bestaat niet");
  const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${account.email.trim().toLowerCase()}`);
  if (taken) throw conflict("email_taken", `Er bestaat al een gebruiker met e-mailadres ${account.email}`);
  return createUser(tx as unknown as Db, actor, {
    organizationId: partnerId,
    email: account.email,
    name: account.name,
    password: randomBytes(32).toString("base64url"),
    mustChangePassword: false,
    mfaRequired: true,
    roleIds: [role.id],
  });
}

export interface PartnerSetup {
  productGroupIds?: string[];
  account?: PartnerAccountInput;
}
export interface InviteDeps {
  transport: EmailTransport | null;
  baseUrl: string;
}

/**
 * Organisatie aanmaken. Een installatiepartner vereist minstens één productgroep en een contactpersoon:
 * die krijgt automatisch een account en een uitnodiging om zijn wachtwoord in te stellen.
 */
export async function createOrganization(db: Db, actor: ActorContext, input: OrganizationInput & PartnerSetup, deps?: InviteDeps) {
  const { productGroupIds, account, ...data } = input;
  const isPartner = data.type === "installation_partner";
  if (isPartner && !productGroupIds?.length) throw badRequest("partner_groups_required", "Kies welke productgroepen deze installatiepartner installeert");
  if (isPartner && !account) throw badRequest("partner_account_required", "Vul de contactpersoon en het e-mailadres in: de installatiepartner krijgt een eigen account");
  const created = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ ...data, email: data.email ?? account?.email ?? null }).returning();
    await recordAudit(tx, actor, { action: "organization.created", entityType: "organization", entityId: org!.id, after: org });
    if (isPartner) await setPartnerGroups(tx, actor, org!.id, productGroupIds!);
    const user = isPartner ? await createPartnerUser(tx, actor, org!.id, account!) : null;
    return { org: org!, userId: user?.id ?? null };
  });
  const invite = created.userId && deps ? await sendInvite(db, deps.transport, deps.baseUrl, actor, created.userId) : null;
  return { ...(await getOrganization(db, created.org.id)), invite };
}

/** Account aanmaken voor een bestaande installatiepartner (zonder account) en uitnodigen. */
export async function createPartnerAccount(db: Db, actor: ActorContext, partnerId: string, account: PartnerAccountInput, deps: InviteDeps) {
  const org = await getOrganization(db, partnerId);
  if (org.type !== "installation_partner") throw badRequest("not_partner", "Alleen voor installatiepartners");
  const user = await db.transaction(async (tx) => {
    const u = await createPartnerUser(tx, actor, partnerId, account);
    if (!org.email) await tx.update(organizations).set({ email: account.email }).where(eq(organizations.id, partnerId));
    return u;
  });
  return { userId: user.id, invite: await sendInvite(db, deps.transport, deps.baseUrl, actor, user.id) };
}

export async function updateOrganization(db: Db, actor: ActorContext, id: string, input: Partial<OrganizationInput> & { productGroupIds?: string[] }) {
  const { productGroupIds, ...data } = input;
  return db.transaction(async (tx) => {
    const before = await getOrganization(tx, id);
    if (productGroupIds !== undefined) {
      if (before.type !== "installation_partner") throw badRequest("not_partner", "Productgroepen gelden alleen voor installatiepartners");
      if (!productGroupIds.length) throw badRequest("partner_groups_required", "Kies minstens één productgroep");
      await setPartnerGroups(tx, actor, id, productGroupIds);
    }
    if (Object.keys(data).length) {
      const [after] = await tx.update(organizations).set(data).where(eq(organizations.id, id)).returning();
      await recordAudit(tx, actor, { action: "organization.updated", entityType: "organization", entityId: id, before, after });
    }
    return getOrganization(tx, id);
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
