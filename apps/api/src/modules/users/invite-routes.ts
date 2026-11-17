import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { acceptInvite, inviteInfo } from "./invites.js";

const Token = z.object({ token: z.string().min(20).max(200) });

/** Openbare routes voor de activatiepagina (/account-activeren/:token). */
export const inviteRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const limit = { auth: "public" as const, rateLimit: { max: 20, timeWindow: "1 minute" } };
  app.get("/public/invites/:token", { config: limit, schema: { params: Token } }, async (req) => inviteInfo(db, req.params.token));
  app.post(
    "/public/invites/:token",
    { config: limit, schema: { params: Token, body: z.object({ password: z.string().min(1).max(256) }) } },
    async (req) => acceptInvite(db, req.params.token, req.body.password, req.ip),
  );
};
