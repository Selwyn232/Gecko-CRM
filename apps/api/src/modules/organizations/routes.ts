import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { forbidden } from "../../lib/errors.js";
import type { EmailTransport } from "../email/transport.js";
import { sendInvite } from "../users/invites.js";
import { organizationType } from "./schema.js";
import {
  createAdvisor,
  createOrganization,
  createPartnerAccount,
  getOrganization,
  listAdvisors,
  listOrganizations,
  updateAdvisor,
  updateOrganization,
} from "./service.js";

const OrgBody = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(organizationType.enumValues),
  kvkNumber: z.string().max(20).nullish(),
  vatNumber: z.string().max(20).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(),
  street: z.string().max(200).nullish(),
  houseNumber: z.string().max(20).nullish(),
  postalCode: z.string().max(10).nullish(),
  city: z.string().max(100).nullish(),
  iban: z.string().max(34).nullish(),
  website: z.string().max(200).nullish(),
  selfBillingPrefix: z.string().regex(/^[A-Z0-9]{2,8}$/, "2–8 hoofdletters/cijfers").nullish(),
  selfBillingVatMode: z.enum(["normal", "reverse_charge"]).nullish(),
  crewCount: z.number().int().min(1).max(20).optional(),
  isActive: z.boolean().optional(),
  /** Installatiepartner: welke productgroepen hij installeert. */
  productGroupIds: z.array(z.string().uuid()).max(50).optional(),
});
const AccountBody = z.object({
  name: z.string().trim().min(1, "Naam contactpersoon is verplicht").max(200),
  email: z.string().trim().email("Ongeldig e-mailadres"),
});
const IdParams = z.object({ id: z.string().uuid() });

export const organizationRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; emailTransport: EmailTransport | null }> = async (app, { db, config, emailTransport }) => {
  const read = requirePermission("organizations.read");
  const manage = requirePermission("organizations.manage");
  const deps = { transport: emailTransport, baseUrl: config.APP_BASE_URL };

  app.get(
    "/organizations",
    {
      preValidation: read,
      schema: {
        querystring: z.object({
          type: z.enum(organizationType.enumValues).optional(),
          isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
        }),
      },
    },
    async (req) => listOrganizations(db, req.query),
  );

  app.get("/organizations/:id", { preValidation: read, schema: { params: IdParams } }, async (req) =>
    getOrganization(db, req.params.id),
  );

  app.post("/organizations", { preValidation: manage, schema: { body: OrgBody.extend({ account: AccountBody.optional() }) } }, async (req, reply) => {
    // Een installatiepartner krijgt een gebruikersaccount: daarvoor is ook gebruikersbeheer nodig.
    if (req.body.type === "installation_partner" && !req.actor.permissions.has("users.manage")) {
      throw forbidden("forbidden", "Voor een installatiepartner wordt een account aangemaakt; daarvoor heb je het recht Gebruikers beheren nodig");
    }
    reply.code(201);
    return createOrganization(db, req.actor, req.body, deps);
  });

  /** Account (met uitnodiging) voor een bestaande installatiepartner zonder account. */
  app.post(
    "/organizations/:id/account",
    { preValidation: [manage, requirePermission("users.manage")], schema: { params: IdParams, body: AccountBody } },
    async (req, reply) => {
      reply.code(201);
      return createPartnerAccount(db, req.actor, req.params.id, req.body, deps);
    },
  );

  /** Uitnodiging (opnieuw) versturen, bv. als de link verlopen is. */
  app.post("/users/:id/invite", { preValidation: requirePermission("users.manage"), schema: { params: IdParams } }, async (req) =>
    sendInvite(db, emailTransport, config.APP_BASE_URL, req.actor, req.params.id),
  );

  app.patch(
    "/organizations/:id",
    { preValidation: manage, schema: { params: IdParams, body: OrgBody.omit({ type: true }).partial() } },
    async (req) => updateOrganization(db, req.actor, req.params.id, req.body),
  );

  const AdvisorBody = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1).max(200),
    email: z.string().email().nullish().or(z.literal("").transform(() => null)),
    phone: z.string().max(30).nullish(),
    isActive: z.boolean().optional(),
  });
  app.get(
    "/advisors",
    { preValidation: read, schema: { querystring: z.object({ organizationId: z.string().uuid().optional() }) } },
    async (req) => listAdvisors(db, req.query.organizationId),
  );
  app.post("/advisors", { preValidation: manage, schema: { body: AdvisorBody } }, async (req, reply) => {
    reply.code(201);
    return createAdvisor(db, req.actor, req.body);
  });
  app.patch(
    "/advisors/:id",
    { preValidation: manage, schema: { params: IdParams, body: AdvisorBody.omit({ organizationId: true }).partial() } },
    async (req) => updateAdvisor(db, req.actor, req.params.id, req.body),
  );
};
