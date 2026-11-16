import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { customers, properties } from "../customers/schema.js";
import { outboundEmails } from "../email/schema.js";
import { files } from "../files/schema.js";
import { invoiceLines, invoices, payments } from "../invoices/schema.js";
import { journeyStatuses } from "../journeys/schema.js";
import { appointments, reports } from "../planning/schema.js";
import { portalLoginTokens, portalSessions } from "../portal/schema.js";
import { projectStatusHistory, projects } from "../projects/schema.js";
import { quoteLines, quoteLinks, quotes } from "../quotes/schema.js";
import { tasks } from "../tasks/schema.js";
import { customerNotes } from "../timeline/schema.js";

/**
 * Inzageverzoek (AVG art. 15): alle gegevens die over een klant zijn vastgelegd, als JSON.
 * Foto's en handtekeningen staan als bestandsnamen in de export; de bestanden zelf zijn op te vragen.
 */
export async function exportCustomerData(db: DbOrTx, actor: ActorContext, customerId: string) {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) throw notFound("Klant");
  const props = await db.select().from(properties).where(eq(properties.customerId, customerId));
  const projs = await db.select().from(projects).where(eq(projects.customerId, customerId));
  const pids = projs.map((p) => p.id);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const qs = await db.select().from(quotes).where(eq(quotes.customerId, customerId));
  const qids = qs.map((q) => q.id);
  const invs = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
  const iids = invs.map((i) => i.id);
  const appts = await db.select().from(appointments).where(inArray(appointments.projectId, pids.length ? pids : none));
  const aids = appts.map((a) => a.id);
  const data = {
    exportedAt: new Date().toISOString(),
    customer,
    properties: props,
    projects: projs,
    statusHistory: await db
      .select({ projectId: projectStatusHistory.projectId, status: journeyStatuses.name, changedAt: projectStatusHistory.changedAt, note: projectStatusHistory.note })
      .from(projectStatusHistory)
      .innerJoin(journeyStatuses, eq(journeyStatuses.id, projectStatusHistory.toStatusId))
      .where(inArray(projectStatusHistory.projectId, pids.length ? pids : none)),
    quotes: qs.map((q) => ({ ...q, internalNote: undefined })),
    quoteLines: await db.select().from(quoteLines).where(inArray(quoteLines.quoteId, qids.length ? qids : none)),
    invoices: invs,
    invoiceLines: await db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, iids.length ? iids : none)),
    payments: await db.select().from(payments).where(inArray(payments.invoiceId, iids.length ? iids : none)),
    appointments: appts,
    reports: await db.select().from(reports).where(inArray(reports.appointmentId, aids.length ? aids : none)),
    files: await db
      .select({ id: files.id, filename: files.filename, contentType: files.contentType, createdAt: files.createdAt })
      .from(files)
      .where(and(eq(files.ownerType, "appointment"), inArray(files.ownerId, aids.length ? aids : none))),
    emails: await db
      .select({ to: outboundEmails.toAddress, subject: outboundEmails.subject, text: outboundEmails.text, status: outboundEmails.status, createdAt: outboundEmails.createdAt })
      .from(outboundEmails)
      .where(eq(outboundEmails.customerId, customerId)),
  };
  await recordAudit(db, actor, { action: "privacy.exported", entityType: "customer", entityId: customerId });
  return data;
}

/**
 * Verwijderverzoek (AVG art. 17): klant anonimiseren. Facturen (met momentopname) blijven 7 jaar bewaard
 * (fiscale bewaarplicht) en offertes als bewijs van de overeenkomst; de rest wordt gewist of geanonimiseerd.
 * Alleen als er geen lopend project of openstaande factuur meer is.
 */
export async function anonymizeCustomer(db: Db, actor: ActorContext, customerId: string, reason: string) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Klant");
  const open = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(and(eq(projects.customerId, customerId), eq(journeyStatuses.isFinal, false)));
  if (open.length) throw conflict("open_projects", "De klant heeft nog een lopend project; rond dat eerst af of annuleer het");
  const [openInv] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.customerId, customerId), eq(invoices.status, "open")));
  if (openInv) throw conflict("open_invoices", "De klant heeft nog een openstaande factuur");
  if (c.lastName === "Geanonimiseerd") throw conflict("already_anonymized", "Klant is al geanonimiseerd");

  await db.transaction(async (tx) => {
    const pids = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.customerId, customerId))).map((p) => p.id);
    const none = ["00000000-0000-0000-0000-000000000000"];
    const aids = (await tx.select({ id: appointments.id }).from(appointments).where(inArray(appointments.projectId, pids.length ? pids : none))).map((a) => a.id);
    await tx
      .update(customers)
      .set({ firstName: null, lastName: "Geanonimiseerd", email: null, phone: null, notes: null })
      .where(eq(customers.id, customerId));
    // Postcode blijft (4 cijfers) voor statistiek; straat en huisnummer weg.
    await tx
      .update(properties)
      .set({ street: "[verwijderd]", houseNumber: "-", houseNumberAddition: null, postalCode: sql`left(${properties.postalCode}, 4)`, notes: null })
      .where(eq(properties.customerId, customerId));
    await tx.delete(customerNotes).where(eq(customerNotes.customerId, customerId));
    await tx.update(tasks).set({ title: "[verwijderd]", description: null }).where(eq(tasks.customerId, customerId));
    await tx
      .update(outboundEmails)
      .set({ toAddress: "[verwijderd]", html: "[verwijderd]", text: "[verwijderd]" })
      .where(eq(outboundEmails.customerId, customerId));
    // Foto's en handtekeningen van de woning: inhoud wissen, registratie behouden.
    if (aids.length) {
      await tx.update(files).set({ data: null, filename: "[verwijderd]" }).where(and(eq(files.ownerType, "appointment"), inArray(files.ownerId, aids)));
      await tx.update(reports).set({ customerSignedName: null }).where(inArray(reports.appointmentId, aids));
    }
    await tx.update(quotes).set({ acceptedByName: "[verwijderd]", customerNote: null }).where(and(eq(quotes.customerId, customerId), ne(quotes.status, "draft")));
    await tx.update(quoteLinks).set({ email: "[verwijderd]" }).where(inArray(quoteLinks.quoteId, (await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.customerId, customerId))).map((q) => q.id).concat(none)));
    if (c.email) {
      const email = c.email.toLowerCase();
      await tx.delete(portalSessions).where(eq(portalSessions.email, email));
      await tx.delete(portalLoginTokens).where(eq(portalLoginTokens.email, email));
    }
    await recordAudit(tx, actor, { action: "privacy.anonymized", entityType: "customer", entityId: customerId, metadata: { reason } });
  });
  return { ok: true };
}


