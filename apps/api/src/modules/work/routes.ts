import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Db } from "../../db/client.js";
import { myWork } from "./service.js";

/** Startpagina "Mijn werk" (alleen ingelogde medewerkers; inhoud volgens rechten). */
export const workRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get("/work", async (req) => myWork(db, req.actor));
};
