import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { systemActor } from "../lib/context.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { loadPermissions } from "../modules/auth/access.js";
import type { Permission } from "../modules/auth/permissions.js";
import type { AuthService } from "../modules/auth/service.js";
import type { Db } from "../db/client.js";
import "./types.js";

export const SESSION_COOKIE = "gecko_session";
/** Bewaart de eigen sessie van de beheerder tijdens "Inloggen als". */
export const ADMIN_SESSION_COOKIE = "gecko_admin_session";

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return req.cookies[SESSION_COOKIE] ?? null;
}

/**
 * Bepaalt bij elk verzoek wie de gebruiker is en dwingt het toegangsniveau van de route af.
 * Standaard is elke API-route afgeschermd ("full"); openbaar maken moet expliciet.
 */
export const authPlugin = fp<{ db: Db; authService: AuthService }>(async (app, { db, authService }) => {
  app.decorateRequest("auth", null);
  app.decorateRequest("actor", null as never);

  app.addHook("onRequest", async (req) => {
    req.actor = { ...systemActor(), requestId: req.id, ip: req.ip };
    // API-routes zijn standaard afgeschermd; overige paden (de webapplicatie zelf) zijn openbaar.
    const level = req.routeOptions.config?.auth ?? (req.url.startsWith("/api/") ? "full" : "public");
    const token = extractToken(req);
    const session = token ? await authService.resolveSession(token) : null;

    if (session) {
      req.auth = session;
      req.actor = {
        userId: session.user.id,
        organizationId: session.user.organizationId,
        permissions: session.mfaVerified ? await loadPermissions(db, session.user.id) : new Set(),
        requestId: req.id,
        ip: req.ip,
        impersonatorUserId: session.impersonatorUserId,
      };
    }

    if (level === "public") return;
    if (!session) throw unauthorized();
    if (level === "full" && !session.mfaVerified) {
      throw forbidden("mfa_required", "Tweestapsverificatie vereist");
    }
    if (level === "full" && session.user.mustChangePassword && !session.impersonatorUserId) {
      throw forbidden("password_change_required", "Kies eerst een eigen wachtwoord");
    }
  });
});

/**
 * Gebruik als `{ preValidation: requirePermission("users.manage") }`. Alle genoemde rechten zijn vereist.
 * preValidation draait vóór de invoervalidatie: wie geen recht heeft, krijgt 403 en leert niets over het formaat.
 */
export const requirePermission =
  (...required: Permission[]) =>
  async (req: FastifyRequest, _reply: FastifyReply) => {
    for (const p of required) {
      if (!req.actor.permissions.has(p)) throw forbidden("missing_permission", `Recht ontbreekt: ${p}`);
    }
  };

export type App = FastifyInstance;
