import type { Permission } from "../modules/auth/permissions.js";

/**
 * Wie voert een actie uit? Wordt door elke service meegegeven, zodat autorisatie en het audit log
 * altijd weten wie wat deed. Systeemacties (automatiseringen) hebben geen userId.
 */
export interface ActorContext {
  userId: string | null;
  organizationId: string | null;
  permissions: ReadonlySet<Permission>;
  requestId?: string;
  ip?: string;
}

export const systemActor = (): ActorContext => ({
  userId: null,
  organizationId: null,
  permissions: new Set(),
});
