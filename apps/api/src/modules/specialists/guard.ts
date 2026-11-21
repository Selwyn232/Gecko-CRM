import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { customers, properties } from "../customers/schema.js";
import { externalQuotes } from "../imports/schema.js";
import { inboundEmails } from "../inbox/schema.js";
import { invoices } from "../invoices/schema.js";
import { appointments, reports } from "../planning/schema.js";
import { projects } from "../projects/schema.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { tasks } from "../tasks/schema.js";
import { assertCustomerVisible, ownCustomersOnly } from "./service.js";

type Resolver = (db: Db, id: string) => Promise<string | null | undefined>;

const viaProject = async (db: Db, projectId: string | null | undefined) =>
  projectId ? (await db.select({ c: projects.customerId }).from(projects).where(eq(projects.id, projectId)))[0]?.c : undefined;
const viaQuote = async (db: Db, quoteId: string | null | undefined) =>
  quoteId ? (await db.select({ c: quotes.customerId }).from(quotes).where(eq(quotes.id, quoteId)))[0]?.c : undefined;

/** Per route-voorvoegsel: hoe vind je de klant achter `:id`. */
const RESOLVERS: [string, Resolver][] = [
  ["/api/customers/:id", async (_db, id) => id],
  ["/api/properties/:id", async (db, id) => (await db.select({ c: properties.customerId }).from(properties).where(eq(properties.id, id)))[0]?.c],
  ["/api/projects/:id", viaProject],
  ["/api/quotes/:id", viaQuote],
  ["/api/quote-lines/:id", async (db, id) => viaQuote(db, (await db.select({ q: quoteLines.quoteId }).from(quoteLines).where(eq(quoteLines.id, id)))[0]?.q)],
  ["/api/invoices/:id", async (db, id) => (await db.select({ c: invoices.customerId }).from(invoices).where(eq(invoices.id, id)))[0]?.c],
  ["/api/appointments/:id", async (db, id) => viaProject(db, (await db.select({ p: appointments.projectId }).from(appointments).where(eq(appointments.id, id)))[0]?.p)],
  [
    "/api/reports/:id",
    async (db, id) =>
      viaProject(db, (await db.select({ p: appointments.projectId }).from(reports).innerJoin(appointments, eq(appointments.id, reports.appointmentId)).where(eq(reports.id, id)))[0]?.p),
  ],
  ["/api/external-quotes/:id", async (db, id) => (await db.select({ c: externalQuotes.customerId }).from(externalQuotes).where(eq(externalQuotes.id, id)))[0]?.c],
  ["/api/inbox/:id", async (db, id) => (await db.select({ c: inboundEmails.customerId }).from(inboundEmails).where(eq(inboundEmails.id, id)))[0]?.c],
  ["/api/tasks/:id", async (db, id) => (await db.select({ c: tasks.customerId }).from(tasks).where(eq(tasks.id, id)))[0]?.c],
];

/**
 * B81: een klantspecialist (zonder recht customers.all) komt alleen bij de eigen klanten. Deze hook controleert
 * elke route met een `:id` van een klantgebonden onderdeel, en `customerId` / `projectId` / `quoteId` in de
 * body of querystring. Lijsten worden in de services zelf gefilterd. Niet zichtbaar = 404 (zelfde als niet bestaand).
 */
export function registerSpecialistGuard(api: FastifyInstance, db: Db) {
  api.addHook("preHandler", async (req: FastifyRequest) => {
    const actor = req.actor;
    if (!actor || !ownCustomersOnly(actor)) return;
    const url = req.routeOptions.url ?? "";
    const params = (req.params ?? {}) as Record<string, string>;
    for (const [prefix, resolve] of RESOLVERS) {
      if ((url === prefix || url.startsWith(`${prefix}/`)) && params.id) {
        await assertCustomerVisible(db, actor, await resolve(db, params.id), "Niet gevonden");
      }
    }
    const refs = { ...((req.query ?? {}) as Record<string, unknown>), ...((req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>) };
    if (typeof refs.customerId === "string") await assertCustomerVisible(db, actor, refs.customerId, "Klant");
    if (typeof refs.projectId === "string") await assertCustomerVisible(db, actor, await viaProject(db, refs.projectId), "Project");
    if (typeof refs.quoteId === "string") await assertCustomerVisible(db, actor, await viaQuote(db, refs.quoteId), "Offerte");
  });
}
