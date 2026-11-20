import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import type { EmailTransport } from "../email/transport.js";
import { invoices } from "../invoices/schema.js";
import { creditInvoice } from "../invoices/service.js";
import { CANCEL_KEY } from "../journeys/defaults.js";
import { journeyStatuses } from "../journeys/schema.js";
import { statusByKeyInJourneyOf } from "../journeys/service.js";
import { appointments } from "../planning/schema.js";
import { cancelAppointment } from "../planning/service.js";
import { quotes } from "../quotes/schema.js";
import { formatQuoteNumber, rejectQuote } from "../quotes/service.js";
import { selfBillingInvoices, selfBillingLines } from "../selfbilling/schema.js";
import { projects } from "./schema.js";
import { changeStatus, formatProjectNumber } from "./service.js";

/** Wat er bij annuleren gebeurt, zodat de medewerker per onderdeel kan kiezen. */
export async function cancellationPreview(db: DbOrTx, projectId: string) {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw notFound("Project");
  const [status] = await db.select().from(journeyStatuses).where(eq(journeyStatuses.id, p.statusId));
  const cancelStatus = await statusByKeyInJourneyOf(db, p.statusId, CANCEL_KEY);
  const appts = await db.select().from(appointments).where(and(eq(appointments.projectId, projectId), eq(appointments.status, "planned")));
  const invs = await db.select().from(invoices).where(and(eq(invoices.projectId, projectId), inArray(invoices.status, ["open", "paid"]), ne(invoices.type, "credit")));
  const openQuotes = await db.select().from(quotes).where(and(eq(quotes.projectId, projectId), eq(quotes.status, "sent")));
  const settled = await db
    .select({ number: selfBillingInvoices.number, kind: selfBillingLines.kind, amount: selfBillingLines.amountCents })
    .from(selfBillingLines)
    .innerJoin(selfBillingInvoices, eq(selfBillingInvoices.id, selfBillingLines.invoiceId))
    .where(and(ne(selfBillingInvoices.status, "draft"), eq(selfBillingLines.projectId, projectId)));
  return {
    projectNumber: formatProjectNumber(p.number),
    canCancel: !!cancelStatus && !status?.isFinal,
    reasonIfNot: !cancelStatus ? "Deze klantreis heeft geen status 'geannuleerd'" : status?.isFinal ? "Project is al afgerond of geannuleerd" : null,
    appointments: appts.map((a) => ({ id: a.id, type: a.type, date: a.date })),
    invoices: invs.map((i) => ({ id: i.id, number: i.number, type: i.type, status: i.status, totalCents: i.totalCents, paidCents: i.paidCents })),
    quotes: openQuotes.map((q) => ({ id: q.id, number: formatQuoteNumber(q.number), kind: q.kind })),
    selfBilling: settled.map((s) => ({ number: s.number, kind: s.kind, amountCents: s.amount })),
  };
}

/**
 * Project annuleren in één keer: geplande afspraken vervallen (partner ziet ze verdwijnen), openstaande offertes worden
 * afgewezen, gekozen facturen gecrediteerd en het project gaat naar "geannuleerd" (de klant krijgt het statusbericht
 * als dat bij Klantberichten aan staat). Terugbetalen en selfbilling-correcties blijven handwerk en worden gemeld.
 */
export async function cancelProject(
  db: Db,
  transport: EmailTransport | null,
  actor: ActorContext,
  projectId: string,
  input: { reason: string; creditInvoiceIds: string[] },
) {
  const preview = await cancellationPreview(db, projectId);
  if (!preview.canCancel) throw conflict("cannot_cancel", preview.reasonIfNot ?? "Annuleren is niet mogelijk");
  const allowed = new Set(preview.invoices.map((i) => i.id));
  if (input.creditInvoiceIds.some((id) => !allowed.has(id))) throw badRequest("invalid_invoice", "Factuur hoort niet bij dit project of is niet te crediteren");

  for (const a of preview.appointments) {
    await cancelAppointment(db, transport, actor, a.id, { reason: `Project geannuleerd: ${input.reason}`, notifyCustomer: false });
  }
  for (const q of preview.quotes) await rejectQuote(db, actor, q.id, `Project geannuleerd: ${input.reason}`);
  const credits = [];
  for (const id of input.creditInvoiceIds) credits.push(await creditInvoice(db, actor, id, `Annulering: ${input.reason}`));

  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  const cancelStatus = await statusByKeyInJourneyOf(db, p!.statusId, CANCEL_KEY);
  await changeStatus(db, actor, projectId, { toStatusId: cancelStatus!.id, note: `Geannuleerd: ${input.reason}`, allowFromAnyOpen: true });
  await recordAudit(db, actor, {
    action: "project.canceled",
    entityType: "project",
    entityId: projectId,
    metadata: { reason: input.reason, appointments: preview.appointments.length, quotes: preview.quotes.length, credited: credits.map((c) => c.number) },
  });
  const refundCents = credits.reduce((s, c) => s + Math.max(0, (preview.invoices.find((i) => i.id === c.creditedInvoiceId)?.paidCents ?? 0)), 0);
  return {
    canceledAppointments: preview.appointments.length,
    rejectedQuotes: preview.quotes.length,
    creditNotes: credits.map((c) => ({ id: c.id, number: c.number, totalCents: c.totalCents })),
    /** Al betaald op gecrediteerde facturen: handmatig terugbetalen. */
    refundCents,
    selfBillingToCorrect: preview.selfBilling,
  };
}
