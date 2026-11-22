import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { customers } from "../customers/schema.js";
import type { BillingDeps } from "../invoices/service.js";
import { eq } from "drizzle-orm";
import {
  logout,
  PORTAL_SESSION_DAYS,
  portalInvoice,
  portalOverview,
  portalPay,
  portalQuoteLink,
  redeemLogin,
  requestLogin,
  reschedule,
  rescheduleOptions,
  sessionEmail,
} from "./service.js";

export const PORTAL_COOKIE = "gecko_portal";
const IdParams = z.object({ id: z.string().uuid() });

/** Klantportaal "Mijn Gecko" (/api/public/portal/*): eigen sessiecookie, los van medewerkers en partners. */
export const portalRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; deps: BillingDeps }> = async (app, { db, config, deps }) => {
  const pub = (max: number) => ({ auth: "public" as const, rateLimit: { max, timeWindow: "1 minute" } });
  const me = (req: FastifyRequest) => sessionEmail(db, req.cookies[PORTAL_COOKIE]);

  app.post("/public/portal/login", { config: pub(5), schema: { body: z.object({ email: z.string().email().max(200) }) } }, async (req) => {
    await requestLogin(db, deps.emailTransport, config.APP_BASE_URL, req.body.email);
    // Altijd hetzelfde antwoord: niet prijsgeven of een adres bekend is.
    return { ok: true };
  });
  app.post("/public/portal/session", { config: pub(10), schema: { body: z.object({ token: z.string().min(20).max(100) }) } }, async (req, reply) => {
    const { session } = await redeemLogin(db, req.body.token);
    reply.setCookie(PORTAL_COOKIE, session, { path: "/", httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", maxAge: PORTAL_SESSION_DAYS * 86_400 });
    return { ok: true };
  });
  app.post("/public/portal/logout", { config: pub(30) }, async (req, reply) => {
    await logout(db, req.cookies[PORTAL_COOKIE]);
    reply.clearCookie(PORTAL_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/public/portal/overview", { config: pub(60) }, async (req) => portalOverview(db, await me(req), deps));
  app.get("/public/portal/invoices/:id", { config: pub(60), schema: { params: IdParams } }, async (req) => portalInvoice(db, await me(req), req.params.id));
  app.post("/public/portal/invoices/:id/pay", { config: pub(10), schema: { params: IdParams } }, async (req) => portalPay(db, deps, await me(req), req.params.id));
  app.post("/public/portal/quotes/:id/link", { config: pub(10), schema: { params: IdParams } }, async (req) => portalQuoteLink(db, await me(req), req.params.id));
  app.get("/public/portal/appointments/:id/options", { config: pub(30), schema: { params: IdParams } }, async (req) =>
    rescheduleOptions(db, await me(req), req.params.id),
  );
  app.post(
    "/public/portal/appointments/:id/reschedule",
    {
      config: pub(5),
      schema: {
        params: IdParams,
        body: z.object({ date: z.string().refine(isIsoDate, "Ongeldige datum"), startMinute: z.number().int().min(480).max(960), technicianId: z.string().uuid() }),
      },
    },
    async (req) => {
      await reschedule(db, deps.emailTransport, await me(req), req.params.id, req.body);
      return { ok: true };
    },
  );

  /** Vanaf de klantkaart: klant uitnodigen voor Mijn Gecko (inloglink per e-mail). */
  app.post("/customers/:id/portal-invite", { preValidation: requirePermission("customers.manage"), schema: { params: IdParams } }, async (req) => {
    const [c] = await db.select().from(customers).where(eq(customers.id, req.params.id));
    if (!c) throw notFound("Klant");
    if (!c.email) throw badRequest("no_email", "Klant heeft geen e-mailadres");
    await requestLogin(db, deps.emailTransport, config.APP_BASE_URL, c.email, req.actor);
    return { sentTo: c.email.toLowerCase() };
  });
};
