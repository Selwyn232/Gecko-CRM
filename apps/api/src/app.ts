import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { authPlugin } from "./http/auth-plugin.js";
import { AppError } from "./lib/errors.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { AuthService } from "./modules/auth/service.js";
import { catalogRoutes } from "./modules/catalog/routes.js";
import { customerRoutes } from "./modules/customers/routes.js";
import { journeyRoutes } from "./modules/journeys/routes.js";
import { projectRoutes } from "./modules/projects/routes.js";
import { quoteRoutes } from "./modules/quotes/routes.js";
import { transportFromConfig, type EmailTransport } from "./modules/email/transport.js";
import { paymentProviderFromConfig, type PaymentProvider } from "./modules/invoices/payments-provider.js";
import { invoiceRoutes } from "./modules/invoices/routes.js";
import type { BillingDeps } from "./modules/invoices/service.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { partnerRoutes } from "./modules/partner/routes.js";
import { planningRoutes } from "./modules/planning/routes.js";
import { testingRoutes } from "./modules/testing/routes.js";
import { messageRoutes } from "./modules/messages/routes.js";
import { selfBillingRoutes } from "./modules/selfbilling/routes.js";
import { reportRoutes } from "./modules/reports/routes.js";
import { checklistRoutes } from "./modules/checklists/routes.js";
import { portalRoutes } from "./modules/portal/routes.js";
import { organizationRoutes } from "./modules/organizations/routes.js";
import { roleRoutes } from "./modules/roles/routes.js";
import { userRoutes } from "./modules/users/routes.js";

/** PostgreSQL-foutcodes die we naar nette meldingen vertalen. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";

export interface AppDeps {
  config: Config;
  db: Db;
  /** Map met de gebouwde webapplicatie. Leeg = alleen API (zoals in tests). */
  webDistDir?: string;
  /** E-mailverzending. Standaard volgens de configuratie (Mailgun of niets); tests geven een eigen transport mee. */
  emailTransport?: EmailTransport | null;
  /** Betaalprovider. Standaard Mollie als er een sleutel is, anders testmodus. */
  paymentProvider?: PaymentProvider;
}

/** Serveert de webapplicatie; onbekende paden buiten /api krijgen index.html (client-side routing). */
async function registerWebApp(app: FastifyInstance, dir: string) {
  await app.register(fastifyStatic, { root: dir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: { code: "not_found", message: "Niet gevonden" } });
  });
}

export async function buildApp({
  config,
  db,
  webDistDir,
  emailTransport = transportFromConfig(config),
  paymentProvider = paymentProviderFromConfig(config),
}: AppDeps) {
  const billing: BillingDeps = { config, emailTransport, paymentProvider };
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            level: config.LOG_LEVEL,
            // Nooit wachtwoorden, tokens of cookies in logs.
            redact: ["req.headers.authorization", "req.headers.cookie", "body.password", "body.newPassword", "body.currentPassword"],
          },
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { "img-src": ["'self'", "data:"], "script-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"] },
    },
  });
  await app.register(cookie);
  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: { code: "rate_limited", message: `Te veel pogingen, probeer het over ${ctx.after} opnieuw` },
      }),
    });
  }

  const authService = new AuthService(db, config);
  await app.register(authPlugin, { db, authService });

  app.setErrorHandler((err: FastifyError & { code?: string; cause?: { code?: string } }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Ongeldige invoer",
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
    }
    const pgCode = (err.cause as { code?: string } | undefined)?.code ?? err.code;
    if (pgCode === PG_UNIQUE_VIOLATION) {
      return reply.code(409).send({ error: { code: "already_exists", message: "Bestaat al" } });
    }
    if (pgCode === PG_FOREIGN_KEY_VIOLATION) {
      return reply.code(400).send({ error: { code: "invalid_reference", message: "Verwijzing naar een onbekend of gebruikt record" } });
    }
    if (pgCode === PG_CHECK_VIOLATION) {
      return reply.code(400).send({ error: { code: "constraint_violation", message: "Waarde niet toegestaan" } });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send(err);
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? "bad_request", message: err.message } });
    }
    req.log.error({ err }, "Onverwachte fout");
    return reply.code(500).send({ error: { code: "internal_error", message: "Er ging iets mis" } });
  });

  app.get("/health", { config: { auth: "public" } }, async () => {
    await db.execute(sql`select 1`);
    return { status: "ok" };
  });

  // Alle API-routes onder /api; de rest van de paden is voor de webapplicatie.
  await app.register(
    async (api) => {
      await api.register(authRoutes, { authService, config, db });
      await api.register(userRoutes, { db });
      await api.register(roleRoutes, { db });
      await api.register(organizationRoutes, { db });
      await api.register(auditRoutes, { db });
      await api.register(catalogRoutes, { db });
      await api.register(customerRoutes, { db });
      await api.register(projectRoutes, { db });
      await api.register(journeyRoutes, { db });
      await api.register(quoteRoutes, { db, config, emailTransport });
      await api.register(invoiceRoutes, { db, deps: billing });
      await api.register(settingsRoutes, { db });
      await api.register(planningRoutes, { db, emailTransport });
      await api.register(partnerRoutes, { db, config, emailTransport });
      await api.register(testingRoutes, { db });
      await api.register(messageRoutes, { db, emailTransport });
      await api.register(selfBillingRoutes, { db, config, emailTransport });
      await api.register(reportRoutes, { db });
      await api.register(checklistRoutes, { db });
      await api.register(portalRoutes, { db, config, deps: billing });
    },
    { prefix: "/api" },
  );

  if (webDistDir) await registerWebApp(app, webDistDir);

  app.decorate("billing", billing);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    billing: BillingDeps;
  }
}
