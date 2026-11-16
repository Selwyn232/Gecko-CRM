import { and, asc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { assertInitialPasswordPolicy, hashPassword } from "../auth/password.js";
import { recoveryCodes, sessions, userRoles, users, type User } from "../auth/schema.js";
import { organizations } from "../organizations/schema.js";
import { assertActiveAdminRemains, assertRolesExist } from "../roles/service.js";

/** Publieke weergave: nooit hashes of geheimen naar buiten. */
export function toPublicUser(u: User, roleIds: string[] = []) {
  return {
    id: u.id,
    organizationId: u.organizationId,
    email: u.email,
    username: u.username,
    name: u.name,
    mfaRequired: u.mfaRequired,
    mustChangePassword: u.mustChangePassword,
    isActive: u.isActive,
    mfaEnabled: u.totpEnabledAt !== null,
    lockedUntil: u.lockedUntil,
    lastLoginAt: u.lastLoginAt,
    roleIds,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

async function roleIdsFor(db: DbOrTx, userIds: string[]) {
  if (!userIds.length) return new Map<string, string[]>();
  const rows = await db.select().from(userRoles).where(inArray(userRoles.userId, userIds));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), r.roleId]);
  return map;
}

async function snapshot(db: DbOrTx, id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!u) return null;
  return toPublicUser(u, ((await roleIdsFor(db, [id])).get(id) ?? []).sort());
}

export async function listUsers(db: DbOrTx, q: { organizationId?: string; search?: string; roleId?: string }) {
  const filters: SQL[] = [];
  if (q.organizationId) filters.push(eq(users.organizationId, q.organizationId));
  if (q.search) {
    filters.push(
      or(ilike(users.name, `%${q.search}%`), ilike(users.email, `%${q.search}%`), ilike(users.username, `%${q.search}%`))!,
    );
  }
  if (q.roleId) {
    filters.push(
      inArray(users.id, db.select({ id: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, q.roleId))),
    );
  }
  const rows = await db
    .select()
    .from(users)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(users.name));
  const roleMap = await roleIdsFor(db, rows.map((r) => r.id));
  return rows.map((u) => toPublicUser(u, roleMap.get(u.id) ?? []));
}

export async function getUser(db: DbOrTx, id: string) {
  const u = await snapshot(db, id);
  if (!u) throw notFound("Gebruiker");
  return u;
}

export interface CreateUserInput {
  organizationId: string;
  email?: string | null;
  username?: string | null;
  name: string;
  password: string;
  roleIds: string[];
  mfaRequired?: boolean;
  /** Standaard: gebruiker kiest bij eerste login een eigen wachtwoord. */
  mustChangePassword?: boolean;
}

const normalizeLogin = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : null);

function assertHasLogin(email: string | null, username: string | null) {
  if (!email && !username) throw badRequest("login_required", "Vul een e-mailadres of gebruikersnaam in");
  if (username && username.includes("@")) throw badRequest("invalid_username", "Een gebruikersnaam mag geen @ bevatten");
}

export async function createUser(db: Db, actor: ActorContext, input: CreateUserInput) {
  const email = normalizeLogin(input.email);
  const username = normalizeLogin(input.username);
  assertHasLogin(email, username);
  const mustChangePassword = input.mustChangePassword ?? true;
  assertInitialPasswordPolicy(input.password, mustChangePassword);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, input.organizationId));
    if (!org) throw badRequest("unknown_organization", "Organisatie bestaat niet");
    await assertRolesExist(tx, input.roleIds);
    const [u] = await tx
      .insert(users)
      .values({
        organizationId: input.organizationId,
        email,
        username,
        name: input.name,
        passwordHash,
        mfaRequired: input.mfaRequired ?? true,
        mustChangePassword,
      })
      .returning();
    if (input.roleIds.length) {
      await tx.insert(userRoles).values([...new Set(input.roleIds)].map((roleId) => ({ userId: u!.id, roleId })));
    }
    const after = (await snapshot(tx, u!.id))!;
    await recordAudit(tx, actor, { action: "user.created", entityType: "user", entityId: u!.id, after });
    return after;
  });
}

export interface UpdateUserInput {
  name?: string;
  email?: string | null;
  username?: string | null;
  mfaRequired?: boolean;
  organizationId?: string;
  isActive?: boolean;
  roleIds?: string[];
}

export async function updateUser(db: Db, actor: ActorContext, id: string, input: UpdateUserInput) {
  return db.transaction(async (tx) => {
    const before = await snapshot(tx, id);
    if (!before) throw notFound("Gebruiker");

    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.email !== undefined) patch.email = normalizeLogin(input.email);
    if (input.username !== undefined) patch.username = normalizeLogin(input.username);
    if (input.mfaRequired !== undefined) patch.mfaRequired = input.mfaRequired;
    if (input.organizationId !== undefined) patch.organizationId = input.organizationId;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (patch.email !== undefined || patch.username !== undefined) {
      assertHasLogin(patch.email !== undefined ? patch.email : before.email, patch.username !== undefined ? patch.username : before.username);
    }
    if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, id));

    if (input.roleIds) {
      await assertRolesExist(tx, input.roleIds);
      await tx.delete(userRoles).where(eq(userRoles.userId, id));
      if (input.roleIds.length) {
        await tx.insert(userRoles).values([...new Set(input.roleIds)].map((roleId) => ({ userId: id, roleId })));
      }
    }
    if (input.isActive === false) await revokeAllSessions(tx, id);
    await assertActiveAdminRemains(tx);

    const after = (await snapshot(tx, id))!;
    await recordAudit(tx, actor, { action: "user.updated", entityType: "user", entityId: id, before, after });
    return after;
  });
}

/**
 * Beheerder zet een nieuw wachtwoord; alle sessies van de gebruiker vervallen.
 * Standaard moet de gebruiker daarna zelf een nieuw wachtwoord kiezen.
 */
export async function adminResetPassword(db: Db, actor: ActorContext, id: string, password: string, mustChangePassword = true) {
  assertInitialPasswordPolicy(password, mustChangePassword);
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const res = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!res.length) throw notFound("Gebruiker");
    await revokeAllSessions(tx, id);
    await recordAudit(tx, actor, { action: "user.password_reset", entityType: "user", entityId: id });
  });
}

/** Beheerder wist 2FA (bv. telefoon kwijt). Gebruiker moet bij volgende login opnieuw instellen. */
export async function adminResetMfa(db: Db, actor: ActorContext, id: string) {
  await db.transaction(async (tx) => {
    const res = await tx
      .update(users)
      .set({ totpSecretEncrypted: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!res.length) throw notFound("Gebruiker");
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, id));
    await revokeAllSessions(tx, id);
    await recordAudit(tx, actor, { action: "user.mfa_reset", entityType: "user", entityId: id });
  });
}

export async function unlockUser(db: Db, actor: ActorContext, id: string) {
  await db.transaction(async (tx) => {
    const res = await tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!res.length) throw notFound("Gebruiker");
    await recordAudit(tx, actor, { action: "user.unlocked", entityType: "user", entityId: id });
  });
}

async function revokeAllSessions(tx: DbOrTx, userId: string) {
  await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

