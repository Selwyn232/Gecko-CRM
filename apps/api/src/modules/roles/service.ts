import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { ADMIN_ROLE_KEY, ALL_PERMISSIONS, isPermission, type Permission } from "../auth/permissions.js";
import { rolePermissions, roles, userRoles, users } from "../auth/schema.js";

export interface RoleInput {
  key: string;
  name: string;
  description?: string | null;
  permissions: string[];
}

function validatePermissions(perms: string[]): Permission[] {
  const unknown = perms.filter((p) => !isPermission(p));
  if (unknown.length) throw badRequest("unknown_permission", `Onbekende rechten: ${unknown.join(", ")}`);
  return [...new Set(perms)] as Permission[];
}

async function getRoleWithPermissions(db: DbOrTx, id: string) {
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!role) return null;
  if (role.key === ADMIN_ROLE_KEY) return { ...role, permissions: [...ALL_PERMISSIONS] };
  const perms = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, id))
    .orderBy(asc(rolePermissions.permission));
  return { ...role, permissions: perms.map((p) => p.permission) };
}

export async function listRoles(db: DbOrTx) {
  const all = await db.select().from(roles).orderBy(asc(roles.name));
  const perms = await db.select().from(rolePermissions);
  const userCounts = await db
    .select({ roleId: userRoles.roleId, n: count() })
    .from(userRoles)
    .groupBy(userRoles.roleId);
  return all.map((r) => ({
    ...r,
    permissions:
      r.key === ADMIN_ROLE_KEY
        ? [...ALL_PERMISSIONS]
        : perms.filter((p) => p.roleId === r.id).map((p) => p.permission).sort(),
    userCount: userCounts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

export async function getRole(db: DbOrTx, id: string) {
  const role = await getRoleWithPermissions(db, id);
  if (!role) throw notFound("Rol");
  return role;
}

export async function createRole(db: Db, actor: ActorContext, input: RoleInput) {
  const perms = validatePermissions(input.permissions);
  return db.transaction(async (tx) => {
    const [role] = await tx
      .insert(roles)
      .values({ key: input.key, name: input.name, description: input.description ?? null })
      .returning();
    if (perms.length) await tx.insert(rolePermissions).values(perms.map((permission) => ({ roleId: role!.id, permission })));
    const result = (await getRoleWithPermissions(tx, role!.id))!;
    await recordAudit(tx, actor, { action: "role.created", entityType: "role", entityId: role!.id, after: result });
    return result;
  });
}

export async function updateRole(
  db: Db,
  actor: ActorContext,
  id: string,
  input: Partial<Omit<RoleInput, "key">>,
) {
  return db.transaction(async (tx) => {
    const before = await getRoleWithPermissions(tx, id);
    if (!before) throw notFound("Rol");
    if (before.key === ADMIN_ROLE_KEY && input.permissions) {
      throw badRequest("admin_role_immutable", "De beheerdersrol heeft altijd alle rechten");
    }
    if (input.name !== undefined || input.description !== undefined) {
      await tx
        .update(roles)
        .set({ name: input.name ?? before.name, description: input.description ?? before.description })
        .where(eq(roles.id, id));
    }
    if (input.permissions) {
      const perms = validatePermissions(input.permissions);
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (perms.length) await tx.insert(rolePermissions).values(perms.map((permission) => ({ roleId: id, permission })));
    }
    const after = (await getRoleWithPermissions(tx, id))!;
    await recordAudit(tx, actor, { action: "role.updated", entityType: "role", entityId: id, before, after });
    return after;
  });
}

export async function deleteRole(db: Db, actor: ActorContext, id: string) {
  await db.transaction(async (tx) => {
    const before = await getRoleWithPermissions(tx, id);
    if (!before) throw notFound("Rol");
    if (before.isSystem) throw badRequest("system_role", "Systeemrollen kunnen niet worden verwijderd");
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, id));
    if (n > 0) throw conflict("role_in_use", `Rol is nog toegekend aan ${n} gebruiker(s)`);
    await tx.delete(roles).where(eq(roles.id, id));
    await recordAudit(tx, actor, { action: "role.deleted", entityType: "role", entityId: id, before });
  });
}

/**
 * Voorkomt dat het systeem zonder actieve beheerder komt te zitten.
 * Aanroepen ná een wijziging aan gebruikers of hun rollen, binnen dezelfde transactie.
 */
export async function assertActiveAdminRemains(tx: DbOrTx) {
  const [row] = await tx
    .select({ n: count() })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(roles.key, ADMIN_ROLE_KEY), eq(users.isActive, true)));
  if (!row || row.n === 0) {
    throw conflict("last_admin", "Er moet minimaal één actieve beheerder overblijven");
  }
}

export async function assertRolesExist(tx: DbOrTx, roleIds: string[]) {
  if (!roleIds.length) return;
  const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
  if (found.length !== new Set(roleIds).size) throw badRequest("unknown_role", "Een of meer rollen bestaan niet");
}
