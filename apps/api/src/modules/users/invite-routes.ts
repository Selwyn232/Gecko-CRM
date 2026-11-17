import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { EmailTransport } from "../email/transport.js";
import { acceptInvite, inviteInfo, requestPasswordReset } from "./invites.js";

const Token = z.object({ token: z.string().min(20).max(200) });

/** Openbare routes voor de activatiepagina (/account-activeren/:token). */
export const inviteRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const limit = { auth: "public" as const, rateLimit: { max: 20, timeWindow: "1 minute" } };
  app.get("/public/invites/:token", { config: limit, schema: { params: Token } }, async (req) => inviteInfo(db, req.params.token));
  app.post(
    "/public/invites/:token",
    { config: limit, schema: { params: Token, body: z.object({ password: z.string().min(1).max(256) }) } },
    async (req) => acceptInvite(db, req.params.token, req.body.password, req.ip),
  );
  /** Wachtwoord vergeten: altijd hetzelfde antwoord. */
  app.post(
    "/public/password-reset",
    { config: { auth: "public" as const, rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { body: z.object({ email: z.string().trim().max(254) }) } },
    async (req) => {
      if (req.body.email.includes("@")) await requestPasswordReset(db, emailTransport, config.APP_BASE_URL, req.body.email, req.ip);
      return { ok: true };
    },
  );
};
