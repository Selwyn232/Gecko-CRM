import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { organizations } from "../organizations/schema.js";
import { ADMIN_SESSION_COOKIE, requirePermission, SESSION_COOKIE } from "../../http/auth-plugin.js";
import { users } from "./schema.js";
import { forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { createHash } from "node:crypto";
import { recordAudit } from "../audit/service.js";
import { cutout, cutoutProvider } from "../photos/cutout.js";
import { loadPermissions } from "./access.js";
import { PasskeyService } from "./passkeys.js";
import { maskPhone, mfaMethod, type AuthService } from "./service.js";
import { PERMISSIONS } from "./permissions.js";

export const authRoutes: FastifyPluginAsyncZod<{ authService: AuthService; config: Config; db: Db }> = async (
  app,
  { authService, config, db },
) => {
  const passkeys = new PasskeyService(db, config, authService);
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
      // Diagnose (zonder IP-adressen): hoeveel proxy-schakels staan in X-Forwarded-For? Nodig om TRUST_PROXY_HOPS te bepalen.
      const xff = req.headers["x-forwarded-for"];
      req.log.info({ xffEntries: typeof xff === "string" ? xff.split(",").length : 0, cfRay: !!req.headers["cf-ray"] }, "login proxy chain");
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
    // Tijdens "Inloggen als" betekent uitloggen: terug naar het eigen account.
    const adminToken = req.cookies[ADMIN_SESSION_COOKIE];
    if (req.auth!.impersonatorUserId && adminToken) {
      reply.setCookie(SESSION_COOKIE, adminToken, cookieOptions).clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
      return { ok: true, returnedToAdmin: true };
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" }).clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post(
    "/users/:id/impersonate",
    { preValidation: requirePermission("users.impersonate"), schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      if (req.auth!.impersonatorUserId) throw unauthorized("already_impersonating", "Keer eerst terug naar je eigen account");
      const token = await authService.startImpersonation(req.auth!.user, req.params.id, req.actor);
      const current = req.cookies[SESSION_COOKIE];
      if (current) reply.setCookie(ADMIN_SESSION_COOKIE, current, cookieOptions);
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: 3600 });
      return { ok: true };
    },
  );

  app.post("/auth/stop-impersonation", { config: { auth: "password" } }, async (req, reply) => {
    if (!req.auth!.impersonatorUserId) return { ok: true };
    await authService.logout(req.auth!.sessionId);
    const adminToken = req.cookies[ADMIN_SESSION_COOKIE];
    if (adminToken) reply.setCookie(SESSION_COOKIE, adminToken, cookieOptions);
    else reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: "/" });
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
      /** B87: monteur (krijgt klussen; ziet "Mijn dag"). */
      isTechnician: user.isTechnician,
      mfaEnabled: mfaMethod(user) !== null,
      mfaMethod: mfaMethod(user),
      mfaVerified,
      /** Mag deze gebruiker 2FA via sms kiezen (recht mfa.sms én sms ingesteld)? */
      smsAllowed: authService.smsAvailable && (await loadPermissions(db, user.id)).has("mfa.sms"),
      smsPhone: user.smsPhone ? maskPhone(user.smsPhone) : null,
      hasPasskey: user.passkeyEnabledAt !== null,
      /** Profielfoto (selfie, verplicht bij elk account); versie voor de cache. */
      hasPhoto: user.photoDataUrl !== null,
      photoVersion: user.photoDataUrl ? createHash("sha1").update(user.photoDataUrl).digest("hex").slice(0, 10) : null,
      /** Domein waarop passkeys werken (bv. crm.gecko.nl). */
      passkeyDomain: passkeys.rpID,
      permissions: [...req.actor.permissions].sort(),
      impersonatedBy: req.auth!.impersonatorUserId
        ? (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, req.auth!.impersonatorUserId)))[0] ?? null
        : null,
    };
  });

  /** Eigen profielfoto (selfie, op het toestel bewerkt). Alleen de gebruiker zelf, niet via "inloggen als". */
  app.put(
    "/auth/me/photo",
    { bodyLimit: 1024 * 1024, schema: { body: z.object({ dataUrl: z.string().max(700_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, "Foto moet een JPEG zijn") }) } },
    async (req) => {
      if (req.auth!.impersonatorUserId) throw forbidden("impersonation_not_allowed", "Een selfie maakt de gebruiker zelf");
      await db.update(users).set({ photoDataUrl: req.body.dataUrl }).where(eq(users.id, req.auth!.user.id));
      await recordAudit(db, req.actor, { action: "user.photo_set", entityType: "user", entityId: req.auth!.user.id });
      return { ok: true };
    },
  );

  /** Professionele uitsnede van de eigen selfie (Photoroom of remove.bg); de browser maakt daarna de eindfoto. */
  app.get("/auth/me/photo/cutout", async () => ({ provider: cutoutProvider() }));
  app.post(
    "/auth/me/photo/cutout",
    {
      bodyLimit: 4 * 1024 * 1024,
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
      schema: { body: z.object({ dataUrl: z.string().max(3_000_000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, "Foto moet een JPEG zijn") }) },
    },
    async (req) => {
      if (req.auth!.impersonatorUserId) throw forbidden("impersonation_not_allowed", "Een selfie maakt de gebruiker zelf");
      const r = await cutout(Buffer.from(req.body.dataUrl.split(",")[1]!, "base64"));
      return { dataUrl: `data:image/png;base64,${r.png.toString("base64")}`, provider: r.provider, relit: r.relit };
    },
  );

  /** Profielfoto van een collega (alleen voor ingelogde gebruikers). */
  app.get("/users/:id/photo", { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req, reply) => {
    const [u] = await db.select({ photo: users.photoDataUrl }).from(users).where(eq(users.id, req.params.id));
    const m = u?.photo?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!m) throw notFound("Foto");
    reply.header("content-type", m[1]!).header("cache-control", "private, max-age=86400");
    return reply.send(Buffer.from(m[2]!, "base64"));
  });

  app.post(
    "/auth/mfa/setup",
    { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      if (req.auth!.impersonatorUserId) throw forbidden("impersonation_not_allowed", "2FA instellen kan alleen de gebruiker zelf");
      return authService.startMfaSetup(req.auth!.user);
    },
  );

  app.post(
    "/auth/mfa/enable",
    {
      config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { body: z.object({ code: z.string() }) },
    },
    async (req) => {
      if (req.auth!.impersonatorUserId) throw forbidden("impersonation_not_allowed", "2FA instellen kan alleen de gebruiker zelf");
      return authService.enableMfa(req.auth!.user, req.auth!.sessionId, req.body.code, req.actor);
    },
  );

  const selfOnly = () => {
    throw forbidden("impersonation_not_allowed", "2FA instellen kan alleen de gebruiker zelf");
  };
  app.post(
    "/auth/mfa/sms/setup",
    { config: { auth: "password", rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { body: z.object({ phone: z.string().min(6).max(30) }) } },
    async (req) => {
      if (req.auth!.impersonatorUserId) selfOnly();
      return authService.startSmsSetup(req.auth!.user, req.body.phone, req.actor);
    },
  );
  app.post(
    "/auth/mfa/sms/enable",
    { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { body: z.object({ code: z.string().min(4).max(12) }) } },
    async (req) => {
      if (req.auth!.impersonatorUserId) selfOnly();
      return authService.enableSms(req.auth!.user, req.auth!.sessionId, req.body.code, req.actor);
    },
  );
  /** Bij inloggen: (nieuwe) sms-code sturen. */
  app.post("/auth/mfa/sms/send", { config: { auth: "password", rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) =>
    authService.sendLoginSms(req.auth!.user, req.actor),
  );

  // ---------------------------------------------------------------- Passkeys (Face ID e.d.)
  const WebAuthnResponse = z.looseObject({ id: z.string().min(1).max(1024), type: z.literal("public-key"), response: z.looseObject({}) });
  const PasskeyBody = z.object({ challengeId: z.string().uuid(), response: WebAuthnResponse });

  app.post("/auth/passkeys/register/options", { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { user, mfaVerified, impersonatorUserId } = req.auth!;
    if (impersonatorUserId) selfOnly();
    // Wie al 2FA heeft, moet eerst volledig ingelogd zijn om een passkey toe te voegen.
    if (mfaMethod(user) && !mfaVerified) throw forbidden("mfa_required", "Log eerst volledig in");
    return passkeys.registrationOptions(user);
  });
  app.post(
    "/auth/passkeys/register",
    { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { body: PasskeyBody.extend({ name: z.string().max(80).default("") }) } },
    async (req) => {
      const { user, mfaVerified, impersonatorUserId, sessionId } = req.auth!;
      if (impersonatorUserId) selfOnly();
      if (mfaMethod(user) && !mfaVerified) throw forbidden("mfa_required", "Log eerst volledig in");
      return passkeys.register(user, sessionId, req.body as never, req.actor);
    },
  );
  /** Inloggen met een passkey, zonder wachtwoord. */
  app.post("/auth/passkeys/login/options", { config: { auth: "public", rateLimit: { max: 20, timeWindow: "1 minute" } } }, async () => passkeys.loginOptions());
  app.post(
    "/auth/passkeys/login",
    { config: { auth: "public", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { body: PasskeyBody } },
    async (req, reply) => {
      const result = await passkeys.login(req.body as never, { ip: req.ip, userAgent: req.headers["user-agent"], requestId: req.id });
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions);
      return { token: result.token, mfa: "none" };
    },
  );
  /** 2FA-stap na het wachtwoord met een passkey. */
  app.post("/auth/passkeys/verify/options", { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) =>
    passkeys.verifyOptions(req.auth!.user),
  );
  app.post(
    "/auth/passkeys/verify",
    { config: { auth: "password", rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { body: PasskeyBody } },
    async (req) => {
      await passkeys.verify(req.auth!.user, req.auth!.sessionId, req.body as never, req.actor);
      return { ok: true };
    },
  );
  app.get("/auth/passkeys", async (req) => passkeys.list(req.auth!.user.id));
  app.delete("/auth/passkeys/:id", { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    if (req.auth!.impersonatorUserId) selfOnly();
    await passkeys.remove(req.auth!.user, req.params.id, req.actor);
    return { ok: true };
  });

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
