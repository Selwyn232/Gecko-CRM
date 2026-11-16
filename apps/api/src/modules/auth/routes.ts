import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { organizations } from "../organizations/schema.js";
import { SESSION_COOKIE } from "../../http/auth-plugin.js";
import { forbidden, unauthorized } from "../../lib/errors.js";
import type { AuthService } from "./service.js";
import { PERMISSIONS } from "./permissions.js";

export const authRoutes: FastifyPluginAsyncZod<{ authService: AuthService; config: Config; db: Db }> = async (
  app,
  { authService, config, db },
) => {
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.NODE_ENV === "production",
    maxAge: config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600,
  };

  app.post(
    "/auth/login",
    {
      config: { auth: "public", rateLimit: { max: 10, timeWindow: "1 minute" } },
      // `email` mag ook een gebruikersnaam zijn (veldnaam behouden voor bestaande clients).
      schema: { body: z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(256) }) },
    },
    async (req, reply) => {
      const result = await authService.login(req.body.email, req.body.password, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.id,
      });
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions);
      // Token ook in de body, voor clients zonder cookies (API, mobiel).
      return { token: result.token, mfa: result.mfa };
    },
  );

  app.post("/auth/logout", { config: { auth: "password" } }, async (req, reply) => {
    await authService.logout(req.auth!.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", { config: { auth: "password" } }, async (req) => {
    const { user, mfaVerified } = req.auth!;
    const [org] = await db.select({ type: organizations.type, name: organizations.name }).from(organizations).where(eq(organizations.id, user.organizationId));
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      mustChangePassword: user.mustChangePassword,
      organizationId: user.organizationId,
      organizationType: org?.type ?? null,
      organizationName: org?.name ?? null,
      mfaEnabled: user.totpEnabledAt !== null,
      mfaVerified,
      permissions: [...req.actor.permissions].sort(),
    };
  });

  app.post(
    "/auth/mfa/setup",
    { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => authService.startMfaSetup(req.auth!.user),
  );

  app.post(
    "/auth/mfa/enable",
    {
      config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: z.object({ code: z.string() }) },
    },
    async (req) => authService.enableMfa(req.auth!.user, req.auth!.sessionId, req.body.code, req.actor),
  );

  app.post(
    "/auth/mfa/verify",
    {
      config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: z
          .object({ code: z.string().optional(), recoveryCode: z.string().optional() })
          .refine((b) => !!b.code !== !!b.recoveryCode, "Geef óf een code óf een herstelcode"),
      },
    },
    async (req) => {
      await authService.verifyMfa(req.auth!.user, req.auth!.sessionId, req.body, req.actor);
      return { ok: true };
    },
  );

  app.post(
    "/auth/change-password",
    {
      // Bereikbaar zonder volledige toegang: wie verplicht een nieuw wachtwoord moet kiezen, moet hier kunnen komen.
      config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: z.object({ currentPassword: z.string(), newPassword: z.string() }) },
    },
    async (req) => {
      if (!req.auth) throw unauthorized();
      if (!req.auth.mfaVerified) throw forbidden("mfa_required", "Tweestapsverificatie vereist");
      await authService.changePassword(
        req.auth.user,
        req.auth.sessionId,
        req.body.currentPassword,
        req.body.newPassword,
        req.actor,
      );
      return { ok: true };
    },
  );

  /** Overzicht van alle bestaande rechten met omschrijving, voor het rollenbeheer. */
  app.get("/permissions", async () =>
    Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
  );
};
