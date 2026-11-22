import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { todayIso } from "../../lib/dates.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { button, escapeHtml, layout } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { invoices } from "../invoices/schema.js";
import { onlinePaymentAvailable, publicInvoiceById, startPaymentForInvoice, type BillingDeps } from "../invoices/service.js";
import { journeyStatuses } from "../journeys/schema.js";
import { inJourney } from "../journeys/service.js";
import { organizations } from "../organizations/schema.js";
import { appointments } from "../planning/schema.js";
import { addDays, cancelAppointment, findSlots, scheduleAppointment, type AppointmentType } from "../planning/service.js";
import { arrivalText } from "../planning/time.js";
import { projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { getCompany, issuePortalQuoteLink } from "../quotes/links.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { calculateTotals, formatQuoteNumber } from "../quotes/service.js";
import { getSetting } from "../settings/service.js";
import { portalLoginTokens, portalSessions } from "./schema.js";

const LOGIN_TTL_MINUTES = 30;
export const PORTAL_SESSION_DAYS = 30;
const system = (email: string): ActorContext => ({ userId: null, organizationId: null, permissions: new Set(), requestId: `portal:${email}` });
const normalize = (email: string) => email.trim().toLowerCase();

async function customerIds(db: DbOrTx, email: string) {
  const rows = await db.select({ id: customers.id }).from(customers).where(sql`lower(${customers.email}) = ${normalize(email)}`);
  return rows.map((r) => r.id);
}

/**
 * Inloglink sturen. Geeft nooit prijs of het adres bekend is (zelfde antwoord), om misbruik te voorkomen.
 * `invitedBy` = medewerker die de klant uitnodigt (vanaf de klantkaart).
 */
export async function requestLogin(db: Db, transport: EmailTransport | null, baseUrl: string, emailInput: string, invitedBy?: ActorContext) {
  const email = normalize(emailInput);
  const ids = await customerIds(db, email);
  if (!ids.length) return { sent: false };
  const token = randomToken();
  await db.insert(portalLoginTokens).values({ email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + LOGIN_TTL_MINUTES * 60_000) });
  const company = await getCompany(db);
  const url = `${baseUrl.replace(/\/$/, "")}/mijn/inloggen/${token}`;
  const html = `<p>Beste klant,</p>
<p>${invitedBy ? `Via Mijn ${escapeHtml(company.name)} volgt u uw project` : "U vroeg om in te loggen op Mijn " + escapeHtml(company.name)}: de status, afspraken, offertes en facturen op één plek. U kunt er ook betalen, meerwerk accepteren en een afspraak verzetten.</p>
${button(url, `Inloggen op Mijn ${company.name}`)}
<p style="font-size:13px;color:#5f6b62">Deze link werkt één keer en is ${LOGIN_TTL_MINUTES} minuten geldig. Daarna kunt u op de inlogpagina een nieuwe link aanvragen. Heeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.</p>`;
  await sendEmail(db, transport, {
    to: email,
    subject: `Inloggen op Mijn ${company.name}`,
    html: layout(company, html),
    text: `${html.replace(/<[^>]+>/g, "").trim()}\n\nInloggen: ${url}`,
    template: "portal.login",
    customerId: ids[0]!,
  });
  await recordAudit(db, invitedBy ?? system(email), { action: invitedBy ? "portal.invited" : "portal.login_requested", entityType: "customer", entityId: ids[0]!, metadata: { email } });
  return { sent: true };
}

/** Eenmalige inloglink inwisselen voor een sessie. */
export async function redeemLogin(db: Db, token: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(portalLoginTokens).where(eq(portalLoginTokens.tokenHash, sha256(token))).for("update");
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new AppError(400, "login_link_invalid", "Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.");
    }
    await tx.update(portalLoginTokens).set({ usedAt: new Date() }).where(eq(portalLoginTokens.id, row.id));
    const session = randomToken();
    await tx.insert(portalSessions).values({ email: row.email, tokenHash: sha256(session), expiresAt: new Date(Date.now() + PORTAL_SESSION_DAYS * 86_400_000) });
    const ids = await customerIds(tx, row.email);
    if (ids[0]) await recordAudit(tx, system(row.email), { action: "portal.login", entityType: "customer", entityId: ids[0], metadata: { email: row.email } });
    return { session, email: row.email };
  });
}

/** E-mailadres van een geldige sessie, of 401. */
export async function sessionEmail(db: DbOrTx, token: string | undefined) {
  if (!token) throw new AppError(401, "portal_unauthorized", "Niet ingelogd");
  const [s] = await db.select().from(portalSessions).where(and(eq(portalSessions.tokenHash, sha256(token)), gt(portalSessions.expiresAt, new Date())));
  if (!s) throw new AppError(401, "portal_unauthorized", "Uw sessie is verlopen; log opnieuw in");
  if (Date.now() - s.lastSeenAt.getTime() > 3_600_000) await db.update(portalSessions).set({ lastSeenAt: new Date() }).where(eq(portalSessions.id, s.id));
  return s.email;
}

export async function logout(db: DbOrTx, token: string | undefined) {
  if (token) await db.delete(portalSessions).where(eq(portalSessions.tokenHash, sha256(token)));
}

// ---------------------------------------------------------------- Overzicht

const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.parse(todayIso())) / 86_400_000);

/** Alles wat de klant ziet: per project status, fases, afspraken, offertes en facturen. Geen interne gegevens. */
export async function portalOverview(db: DbOrTx, email: string, deps?: BillingDeps) {
  const ids = await customerIds(db, email);
  if (!ids.length) throw new AppError(401, "portal_unauthorized", "Niet ingelogd");
  const [cust] = await db.select().from(customers).where(eq(customers.id, ids[0]!));
  const window = await getSetting(db, "quote.change_window_days");
  const rows = await db
    .select({ p: projects, group: productGroups, property: properties, status: journeyStatuses })
    .from(projects)
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(inArray(projects.customerId, ids))
    .orderBy(desc(projects.createdAt));
  const result = [];
  for (const r of rows) {
    const phases = await db
      .selectDistinct({ phase: journeyStatuses.phase, sort: sql<number>`min(${journeyStatuses.sortOrder}) OVER (PARTITION BY ${journeyStatuses.phase})` })
      .from(journeyStatuses)
      .where(and(inJourney(r.status.productGroupId, r.status.salesChannelId), eq(journeyStatuses.isActive, true), ne(journeyStatuses.key, "geannuleerd")));
    const appts = await db
      .select({ a: appointments, partnerName: organizations.name })
      .from(appointments)
      .innerJoin(organizations, eq(organizations.id, appointments.partnerOrganizationId))
      .where(and(eq(appointments.projectId, r.p.id), inArray(appointments.status, ["planned", "completed"])))
      .orderBy(asc(appointments.date));
    const qs = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.projectId, r.p.id), inArray(quotes.status, ["sent", "accepted"])))
      .orderBy(asc(quotes.number));
    const quoteViews = [];
    for (const q of qs) {
      const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, q.id));
      quoteViews.push({
        id: q.id,
        number: formatQuoteNumber(q.number),
        kind: q.kind,
        status: q.status === "sent" && q.validUntil && q.validUntil < todayIso() ? "expired" : q.status,
        validUntil: q.validUntil,
        acceptedAt: q.acceptedAt,
        totalCents: calculateTotals(lines).totalCents,
      });
    }
    const invs = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.projectId, r.p.id), ne(invoices.status, "draft")))
      .orderBy(asc(invoices.invoiceDate));
    const canceled = r.status.isFinal && r.status.key === "geannuleerd";
    result.push({
      id: r.p.id,
      number: formatProjectNumber(r.p.number),
      productGroup: r.group.name,
      address: `${r.property.street} ${r.property.houseNumber}${r.property.houseNumberAddition ? `-${r.property.houseNumberAddition}` : ""}, ${r.property.postalCode} ${r.property.city}`,
      status: { name: r.status.name, phase: r.status.phase, isFinal: r.status.isFinal, canceled },
      phases: phases.sort((a, b) => Number(a.sort) - Number(b.sort)).map((p) => p.phase),
      appointments: appts.map(({ a, partnerName }) => ({
        id: a.id,
        type: a.type,
        date: a.date,
        days: a.days,
        timeWindow: a.timeWindow,
        arrival: arrivalText(a.startMinute),
        status: a.status,
        partnerName,
        canReschedule: a.status === "planned" && daysUntil(a.date) >= window,
      })),
      quotes: quoteViews,
      invoices: invs.map((i) => ({
        id: i.id,
        number: i.number,
        type: i.type,
        status: i.status,
        invoiceDate: i.invoiceDate,
        dueDate: i.dueDate,
        totalCents: i.totalCents,
        outstandingCents: Math.max(0, i.totalCents - i.paidCents),
        paymentReference: i.paymentReference ?? i.number,
      })),
    });
  }
  const company = await getCompany(db);
  return {
    name: [cust!.firstName, cust!.lastName].filter(Boolean).join(" "),
    email,
    rescheduleWindowDays: window,
    projects: result,
    // Zonder Mollie: geen knop "Betalen", wel de overschrijvingsgegevens (B79).
    onlinePayment: deps ? await onlinePaymentAvailable(db, deps) : false,
    iban: (company as { iban?: string }).iban ?? null,
    companyName: company.name,
  };
}

// ---------------------------------------------------------------- Acties (altijd met eigendomscontrole)

async function ownProject(db: DbOrTx, email: string, projectId: string) {
  const ids = await customerIds(db, email);
  const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), inArray(projects.customerId, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])));
  if (!p) throw notFound("Project");
  return p;
}

export async function portalInvoice(db: DbOrTx, email: string, invoiceId: string) {
  const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), ne(invoices.status, "draft")));
  if (!inv?.projectId) throw notFound("Factuur");
  await ownProject(db, email, inv.projectId);
  return publicInvoiceById(db, invoiceId);
}

export async function portalPay(db: Db, deps: BillingDeps, email: string, invoiceId: string) {
  await portalInvoice(db, email, invoiceId);
  return startPaymentForInvoice(db, deps, invoiceId, `${deps.config.APP_BASE_URL.replace(/\/$/, "")}/mijn?betaald=1`);
}

/** Naar de akkoordpagina van een openstaande offerte (meerwerk of hoofdofferte). */
export async function portalQuoteLink(db: Db, email: string, quoteId: string) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  if (!q?.projectId) throw notFound("Offerte");
  await ownProject(db, email, q.projectId);
  return { url: `/akkoord/${await issuePortalQuoteLink(db, quoteId, email)}` };
}

async function ownAppointment(db: DbOrTx, email: string, appointmentId: string) {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!a) throw notFound("Afspraak");
  await ownProject(db, email, a.projectId);
  const window = await getSetting(db, "quote.change_window_days");
  if (a.status !== "planned") throw conflict("not_planned", "Deze afspraak kan niet meer worden verzet");
  if (daysUntil(a.date) < window) throw conflict("too_late", `Verzetten kan tot ${window} dagen voor de afspraak. Neem contact met ons op.`);
  return a;
}

/** Andere momenten bij dezelfde installateur (na de minimale voorlooptijd). */
export async function rescheduleOptions(db: DbOrTx, email: string, appointmentId: string) {
  const a = await ownAppointment(db, email, appointmentId);
  const { slots } = await findSlots(db, a.projectId, a.type as AppointmentType);
  const window = await getSetting(db, "quote.change_window_days");
  const earliest = addDays(todayIso(), window);
  return slots
    .filter((s) => s.partnerId === a.partnerOrganizationId && s.date >= earliest && !(s.date === a.date && s.startMinute === a.startMinute))
    .slice(0, 40)
    .map((s) => ({ date: s.date, startMinute: s.startMinute, technicianId: s.technicianId, arrival: arrivalText(s.startMinute), days: s.days, part: null }));
}

/** Verzetten: oude afspraak vervalt, nieuwe bij dezelfde installateur. Mislukt de nieuwe, dan blijft de oude staan. */
export async function reschedule(
  db: Db,
  transport: EmailTransport | null,
  email: string,
  appointmentId: string,
  input: { date: string; startMinute: number; technicianId: string },
) {
  const a = await ownAppointment(db, email, appointmentId);
  const options = await rescheduleOptions(db, email, appointmentId);
  if (!options.some((o) => o.date === input.date && o.startMinute === input.startMinute && o.technicianId === input.technicianId)) {
    throw badRequest("slot_unavailable", "Dit moment is niet (meer) beschikbaar; kies een ander moment");
  }
  const actor = system(email);
  const type = a.type as AppointmentType;
  await cancelAppointment(db, transport, actor, a.id, { reason: "Verzet door klant via Mijn Gecko", notifyCustomer: false });
  try {
    const next = await scheduleAppointment(db, transport, actor, a.projectId, { type, date: input.date, technicianId: input.technicianId, startMinute: input.startMinute, notes: a.notes });
    await recordAudit(db, actor, { action: "appointment.rescheduled_by_customer", entityType: "project", entityId: a.projectId, before: { date: a.date, start: a.startMinute }, after: { date: input.date, start: input.startMinute } });
    return next;
  } catch (err) {
    // Terugzetten op het oude moment (dat is net vrijgekomen).
    if (a.technicianUserId && a.startMinute != null) {
      await scheduleAppointment(db, null, actor, a.projectId, { type, date: a.date, technicianId: a.technicianUserId, startMinute: a.startMinute, notes: a.notes });
    }
    throw err;
  }
}

