import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { externalQuoteFile, importGreenteamQuote, listExternalQuotes, previewGreenteamQuote } from "./service.js";

const IdParams = z.object({ id: z.string().uuid() });
const FileBody = { filename: z.string().min(1).max(200), dataBase64: z.string().min(10) };
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const importRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const read = requirePermission("customers.read");
  const manage = requirePermission("customers.manage");
  const bodyLimit = 12 * 1024 * 1024;

  /** Greenteam-offerte (PDF) uitlezen; slaat niets op. */
  app.post("/imports/greenteam/preview", { preValidation: manage, bodyLimit, schema: { body: z.object(FileBody) } }, async (req) =>
    previewGreenteamQuote(db, req.body.dataBase64),
  );

  /** Inlezen: klant aanmaken of koppelen, PDF en gegevens op de klantkaart. */
  app.post(
    "/imports/greenteam",
    {
      preValidation: manage,
      bodyLimit,
      schema: {
        body: z.object({
          ...FileBody,
          existingCustomerId: z.string().uuid().nullish().transform((v) => v ?? null),
          productGroupId: z.string().uuid().nullish().transform((v) => v ?? null),
          customer: z.object({
            firstName: opt(100),
            lastName: z.string().trim().min(1, "Achternaam is verplicht").max(100),
            email: z.string().trim().email("Ongeldig e-mailadres").nullish().or(z.literal("")).transform((v) => v || null),
            phone: opt(30),
            street: z.string().trim().min(1, "Straat is verplicht").max(200),
            houseNumber: z.string().trim().min(1, "Huisnummer is verplicht").max(10),
            houseNumberAddition: opt(10),
            postalCode: z.string().trim().min(4, "Postcode is verplicht").max(10),
            city: z.string().trim().min(1, "Plaats is verplicht").max(100),
          }),
        }),
      },
    },
    async (req, reply) => {
      reply.code(201);
      return importGreenteamQuote(db, req.actor, req.body);
    },
  );

  app.get("/customers/:id/external-quotes", { preValidation: read, schema: { params: IdParams } }, async (req) => listExternalQuotes(db, req.params.id));

  app.get("/external-quotes/:id/pdf", { preValidation: read, schema: { params: IdParams } }, async (req, reply) => {
    const f = await externalQuoteFile(db, req.params.id);
    reply
      .header("content-type", f.contentType)
      .header("cache-control", "private, max-age=3600")
      .header("content-disposition", `inline; filename="${f.filename}"`)
      .header("x-content-type-options", "nosniff");
    return f.data;
  });
};
