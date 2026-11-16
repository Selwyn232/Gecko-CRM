import { eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { ADMIN_ROLE_KEY, ALL_PERMISSIONS, isPermission, type Permission } from "./permissions.js";
import { rolePermissions, roles, userRoles } from "./schema.js";

/** Alle rechten van een gebruiker, samengesteld uit zijn rollen. De beheerdersrol heeft altijd alles. */
export async function loadPermissions(db: DbOrTx, userId: string): Promise<Set<Permission>> {
  const userRoleRows = await db
    .select({ roleId: roles.id, key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));

  if (userRoleRows.some((r) => r.key === ADMIN_ROLE_KEY)) return new Set(ALL_PERMISSIONS);
  if (userRoleRows.length === 0) return new Set();

  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(
      inArray(
        rolePermissions.roleId,
        userRoleRows.map((r) => r.roleId),
      ),
    );
  return new Set(rows.map((r) => r.permission).filter(isPermission));
}

/** Rechten die een set rollen samen geeft (beheerdersrol = alles). */
export async function permissionsOfRoles(db: DbOrTx, roleIds: string[]): Promise<Set<Permission>> {
  if (!roleIds.length) return new Set();
  const rs = await db.select({ id: roles.id, key: roles.key }).from(roles).where(inArray(roles.id, roleIds));
  if (rs.some((r) => r.key === ADMIN_ROLE_KEY)) return new Set(ALL_PERMISSIONS);
  const rows = await db.select({ permission: rolePermissions.permission }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
  return new Set(rows.map((r) => r.permission).filter(isPermission));
}

/**
 * Geen escalatie: je kunt geen rechten uitdelen (of een account overnemen met rechten) die je zelf niet hebt.
 * Geeft de ontbrekende rechten terug.
 */
export function missingPermissions(actor: ReadonlySet<Permission>, wanted: Iterable<Permission>) {
  return [...wanted].filter((p) => !actor.has(p));
}
