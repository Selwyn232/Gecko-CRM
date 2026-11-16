import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { escapeHtml, layout } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { emitEvent } from "../events/service.js";
import { emitJourneyEvent } from "../journeys/auto.js";
import { journeyStatuses, journeyTransitions } from "../journeys/schema.js";
import { organizations } from "../organizations/schema.js";
import { projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { getCompany } from "../quotes/links.js";
import { quotes } from "../quotes/schema.js";
import { addLineInTx } from "../quotes/service.js";
import { getSetting } from "../settings/service.js";
import { appointments, availability, regions, reports, type ReportData } from "./schema.js";

type AppointmentType = "survey" | "installation";
const TYPE_LABEL: Record<AppointmentType, string> = { survey: "schouw", installation: "installatie" };
const WINDOW_LABEL = { morning: "in de ochtend (8:00–12:00)", afternoon: "in de middag (12:00–17:00)", day: "gedurende de dag" } as const;

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const dateNl = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

// ---------------------------------------------------------------- Regio's

export const postalNumber = (postalCode: string) => Number(postalCode.replace(/\D/g, "").slice(0, 4));

export function regionContains(ranges: [number, number][], postalCode: string) {
  const n = postalNumber(postalCode);
  return ranges.some(([from, to]) => n >= from && n <= to);
}

function validateRanges(ranges: [number, number][]) {
  for (const [a, b] of ranges) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1000 || b > 9999 || a > b) {
      throw badRequest("invalid_range", "Postcodegebieden moeten tussen 1000 en 9999 liggen, van laag naar hoog");
    }
  }
}

export const listRegions = (db: DbOrTx) => db.select().from(regions).orderBy(asc(regions.name));

export async function saveRegion(db: Db, actor: ActorContext, id: string | null, input: { name: string; postalRanges: [number, number][]; isActive?: boolean }) {
  validateRanges(input.postalRanges);
  return db.transaction(async (tx) => {
    if (id) {
      const [before] = await tx.select().from(regions).where(eq(regions.id, id));
      if (!before) throw notFound("Regio");
      const [after] = await tx.update(regions).set(input).where(eq(regions.id, id)).returning();
      await recordAudit(tx, actor, { action: "region.updated", entityType: "region", entityId: id, before, after });
      return after!;
    }
    const [row] = await tx.insert(regions).values(input).returning();
    await recordAudit(tx, actor, { action: "region.created", entityType: "region", entityId: row!.id, after: row });
    return row!;
  });
}

async function regionsForPostal(db: DbOrTx, postalCode: string) {
  const all = await db.select().from(regions).where(eq(regions.isActive, true));
  return all.filter((r) => regionContains(r.postalRanges, postalCode));
}

// ---------------------------------------------------------------- Beschikbaarheid

export interface AvailabilityEntry {
  regionId: string;
  date: string;
  surveySlots: number;
  installationSlots: number;
}

export async function listAvailability(db: DbOrTx, q: { from: string; to: string; partnerId?: string }) {
  const filters: SQL[] = [gte(availability.date, q.from), lte(availability.date, q.to)];
  if (q.partnerId) filters.push(eq(availability.partnerOrganizationId, q.partnerId));
  const rows = await db.select().from(availability).where(and(...filters)).orderBy(asc(availability.date));
  const used = await usedCapacity(db, q.from, q.to, q.partnerId);
  return rows.map((r) => {
    const u = used.get(`${r.partnerOrganizationId}|${r.regionId}|${r.date}`) ?? { survey: 0, installation: 0 };
    return { ...r, surveyUsed: u.survey, installationUsed: u.installation };
  });
}

/** Zet beschikbaarheid (upsert). Verlagen onder het aantal al geplande afspraken mag niet. */
export async function setAvailability(db: Db, actor: ActorContext, partnerId: string, entries: AvailabilityEntry[]) {
  const [partner] = await db.select().from(organizations).where(eq(organizations.id, partnerId));
  if (!partner || partner.type !== "installation_partner") throw badRequest("invalid_partner", "Organisatie is geen installatiepartner");
  const today = todayIso();
  await db.transaction(async (tx) => {
    for (const e of entries) {
      if (e.date < today) throw badRequest("date_in_past", "Beschikbaarheid in het verleden kan niet worden gewijzigd");
      const used = (await usedCapacity(tx, e.date, e.date, partnerId)).get(`${partnerId}|${e.regionId}|${e.date}`);
      if (used && (e.surveySlots < used.survey || e.installationSlots < used.installation)) {
        throw conflict("capacity_in_use", `Op ${e.date} zijn al afspraken gepland; capaciteit kan niet lager dan ${used.survey} schouw(en) / ${used.installation} installatie(s)`);
      }
      await tx
        .insert(availability)
        .values({ partnerOrganizationId: partnerId, regionId: e.regionId, date: e.date, surveySlots: e.surveySlots, installationSlots: e.installationSlots })
        .onConflictDoUpdate({
          target: [availability.partnerOrganizationId, availability.regionId, availability.date],
          set: { surveySlots: e.surveySlots, installationSlots: e.installationSlots, updatedAt: new Date() },
        });
    }
    await recordAudit(tx, actor, { action: "availability.updated", entityType: "organization", entityId: partnerId, metadata: { entries: entries.length } });
  });
}

/** Bezette capaciteit per partner|regio|datum. Een installatie van N dagen bezet N dagen. */
async function usedCapacity(db: DbOrTx, from: string, to: string, partnerId?: string) {
  const filters: SQL[] = [inArray(appointments.status, ["planned", "completed"]), lte(appointments.date, to), gte(sql`${appointments.date} + (${appointments.days} - 1)`, from)];
  if (partnerId) filters.push(eq(appointments.partnerOrganizationId, partnerId));
  const rows = await db.select().from(appointments).where(and(...filters));
  const map = new Map<string, { survey: number; installation: number }>();
  for (const a of rows) {
    for (let i = 0; i < a.days; i++) {
      const key = `${a.partnerOrganizationId}|${a.regionId}|${addDays(a.date, i)}`;
      const cur = map.get(key) ?? { survey: 0, installation: 0 };
      cur[a.type]++;
      map.set(key, cur);
    }
  }
  return map;
}

// ---------------------------------------------------------------- Vrije momenten

async function projectContext(db: DbOrTx, projectId: string) {
  const [row] = await db
    .select({ project: projects, property: properties, group: productGroups, customer: customers })
    .from(projects)
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .where(eq(projects.id, projectId));
  if (!row) throw notFound("Project");
  return row;
}

export async function findSlots(db: DbOrTx, projectId: string, type: AppointmentType) {
  const ctx = await projectContext(db, projectId);
  const regs = await regionsForPostal(db, ctx.property.postalCode);
  if (!regs.length) return { regions: [], slots: [], message: `Postcode ${ctx.property.postalCode} valt in geen enkele regio. Voeg hem toe bij Regio's.` };
  const lead = await getSetting(db, type === "survey" ? "planning.survey_lead_days" : "planning.installation_lead_days");
  const horizon = await getSetting(db, "planning.horizon_days");
  const from = addDays(todayIso(), lead);
  const to = addDays(todayIso(), horizon);
  const days = type === "installation" ? ctx.group.installationDays : 1;

  const filters: SQL[] = [inArray(availability.regionId, regs.map((r) => r.id)), gte(availability.date, from), lte(availability.date, addDays(to, days))];
  // Installatie bij dezelfde partner als de schouw (die partner kent de situatie en is verantwoordelijk voor gemist meerwerk).
  if (type === "installation" && ctx.project.installationPartnerId) filters.push(eq(availability.partnerOrganizationId, ctx.project.installationPartnerId));
  const avail = await db
    .select({ a: availability, partnerName: organizations.name })
    .from(availability)
    .innerJoin(organizations, eq(organizations.id, availability.partnerOrganizationId))
    .where(and(...filters, eq(organizations.isActive, true)));
  const used = await usedCapacity(db, from, addDays(to, days));
  const cap = (a: (typeof avail)[number]["a"]) => (type === "survey" ? a.surveySlots : a.installationSlots);
  const free = (partnerId: string, regionId: string, date: string) => {
    const a = avail.find((x) => x.a.partnerOrganizationId === partnerId && x.a.regionId === regionId && x.a.date === date);
    if (!a) return 0;
    return cap(a.a) - (used.get(`${partnerId}|${regionId}|${date}`)?.[type] ?? 0);
  };

  const slots = avail
    .filter((x) => x.a.date <= to && cap(x.a) > 0)
    .map((x) => {
      // Meerdaagse installatie: elke dag moet capaciteit hebben.
      let f = Infinity;
      for (let i = 0; i < days; i++) f = Math.min(f, free(x.a.partnerOrganizationId, x.a.regionId, addDays(x.a.date, i)));
      return { date: x.a.date, partnerId: x.a.partnerOrganizationId, partnerName: x.partnerName, regionId: x.a.regionId, free: f, days };
    })
    .filter((s) => s.free > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.partnerName.localeCompare(b.partnerName));
  return { regions: regs.map((r) => ({ id: r.id, name: r.name })), slots, message: slots.length ? null : "Geen vrije capaciteit gevonden in deze periode." };
}

// ---------------------------------------------------------------- Afspraken

export async function scheduleAppointment(
  db: Db,
  transport: EmailTransport | null,
  actor: ActorContext,
  projectId: string,
  input: { type: AppointmentType; date: string; partnerId: string; regionId: string; timeWindow: "morning" | "afternoon" | "day"; notes?: string | null },
) {
  const appointment = await db.transaction(async (tx) => {
    const ctx = await projectContext(tx, projectId);
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (input.type === "installation" && project!.installationPartnerId && project!.installationPartnerId !== input.partnerId) {
      throw badRequest("partner_mismatch", "De installatie moet bij dezelfde partner als de schouw");
    }
    const [existing] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.projectId, projectId), eq(appointments.type, input.type), eq(appointments.status, "planned")));
    if (existing) throw conflict("already_planned", `Er staat al een ${TYPE_LABEL[input.type]} gepland; verzet of annuleer die eerst`);
    const regs = await regionsForPostal(tx, ctx.property.postalCode);
    if (!regs.some((r) => r.id === input.regionId)) throw badRequest("region_mismatch", "Adres ligt niet in deze regio");

    const days = input.type === "installation" ? ctx.group.installationDays : 1;
    // Capaciteit vergrendelen en opnieuw controleren (voorkomt dubbel boeken bij gelijktijdig plannen).
    for (let i = 0; i < days; i++) {
      const date = addDays(input.date, i);
      const [a] = await tx
        .select()
        .from(availability)
        .where(and(eq(availability.partnerOrganizationId, input.partnerId), eq(availability.regionId, input.regionId), eq(availability.date, date)))
        .for("update");
      const cap = a ? (input.type === "survey" ? a.surveySlots : a.installationSlots) : 0;
      const used = (await usedCapacity(tx, date, date, input.partnerId)).get(`${input.partnerId}|${input.regionId}|${date}`)?.[input.type] ?? 0;
      if (cap - used <= 0) throw conflict("no_capacity", `Geen capaciteit meer op ${date}`);
    }

    const [row] = await tx
      .insert(appointments)
      .values({ projectId, partnerOrganizationId: input.partnerId, regionId: input.regionId, type: input.type, date: input.date, days, timeWindow: input.timeWindow, notes: input.notes ?? null, createdBy: actor.userId })
      .returning();
    if (!project!.installationPartnerId) await tx.update(projects).set({ installationPartnerId: input.partnerId }).where(eq(projects.id, projectId));
    await recordAudit(tx, actor, { action: "appointment.scheduled", entityType: "project", entityId: projectId, after: { type: input.type, date: input.date, partnerId: input.partnerId } });
    await emitEvent(tx, "appointment.scheduled", { type: "appointment", id: row!.id }, { projectId, type: input.type, date: input.date });
    await emitJourneyEvent(tx, projectId, `${input.type}.scheduled`);
    return row!;
  });
  await notifyCustomer(db, transport, appointment.id, "scheduled");
  return getAppointment(db, appointment.id);
}

export async function cancelAppointment(
  db: Db,
  transport: EmailTransport | null,
  actor: ActorContext,
  id: string,
  input: { reason: string; partnerNoShow?: boolean; notifyCustomer?: boolean },
) {
  await db.transaction(async (tx) => {
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, id)).for("update");
    if (!a) throw notFound("Afspraak");
    if (a.status !== "planned") throw conflict("not_planned", "Alleen een geplande afspraak kan worden geannuleerd");
    await tx.update(appointments).set({ status: input.partnerNoShow ? "partner_no_show" : "canceled", cancelReason: input.reason }).where(eq(appointments.id, id));
    await recordAudit(tx, actor, {
      action: input.partnerNoShow ? "appointment.partner_no_show" : "appointment.canceled",
      entityType: "project",
      entityId: a.projectId,
      metadata: { appointmentId: id, reason: input.reason, partnerId: a.partnerOrganizationId },
    });
    await emitEvent(tx, "appointment.canceled", { type: "appointment", id }, { projectId: a.projectId, partnerNoShow: !!input.partnerNoShow });
  });
  if (input.notifyCustomer !== false) await notifyCustomer(db, transport, id, "canceled");
  return getAppointment(db, id);
}

async function notifyCustomer(db: Db, transport: EmailTransport | null, appointmentId: string, kind: "scheduled" | "canceled") {
  const a = await getAppointment(db, appointmentId);
  if (!a.customer.email) return;
  const company = await getCompany(db);
  const what = TYPE_LABEL[a.type as AppointmentType];
  const name = [a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ");
  const html =
    kind === "scheduled"
      ? `<p>Beste ${escapeHtml(name)},</p><p>De ${what} voor uw ${escapeHtml(a.productGroupName.toLowerCase())} is ingepland op <strong>${dateNl(a.date)}</strong>, ${WINDOW_LABEL[a.timeWindow]}${a.days > 1 ? ` (${a.days} dagen)` : ""}.</p><p>Adres: ${escapeHtml(a.address)}<br>Uitgevoerd door: ${escapeHtml(a.partnerName)}</p><p>Komt deze datum niet uit? Beantwoord dan deze e-mail.</p>`
      : `<p>Beste ${escapeHtml(name)},</p><p>De ${what} op ${dateNl(a.date)} gaat helaas niet door. Wij nemen contact met u op voor een nieuwe afspraak.</p>`;
  await sendEmail(db, transport, {
    to: a.customer.email,
    subject: kind === "scheduled" ? `Uw ${what} is ingepland op ${dateNl(a.date)}` : `Uw ${what} op ${dateNl(a.date)} gaat niet door`,
    template: `appointment.${kind}`,
    customerId: a.customer.id,
    related: { type: "appointment", id: a.id },
    html: layout(company, html),
    text: html.replace(/<[^>]+>/g, "").replace(/\n+/g, "\n"),
  });
}

export async function getAppointment(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ a: appointments, project: projects, property: properties, customer: customers, partnerName: organizations.name, regionName: regions.name, groupName: productGroups.name })
    .from(appointments)
    .innerJoin(projects, eq(projects.id, appointments.projectId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .innerJoin(organizations, eq(organizations.id, appointments.partnerOrganizationId))
    .innerJoin(regions, eq(regions.id, appointments.regionId))
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .where(eq(appointments.id, id));
  if (!row) throw notFound("Afspraak");
  const [report] = await db.select().from(reports).where(eq(reports.appointmentId, id));
  return toView(row, report ?? null);
}

function toView(
  row: { a: typeof appointments.$inferSelect; project: typeof projects.$inferSelect; property: typeof properties.$inferSelect; customer: typeof customers.$inferSelect; partnerName: string; regionName: string; groupName: string },
  report: typeof reports.$inferSelect | null,
) {
  const p = row.property;
  return {
    ...row.a,
    projectNumber: formatProjectNumber(row.project.number),
    productGroupName: row.groupName,
    partnerName: row.partnerName,
    regionName: row.regionName,
    address: `${p.street} ${p.houseNumber}${p.houseNumberAddition ? `-${p.houseNumberAddition}` : ""}, ${p.postalCode} ${p.city}`,
    customer: { id: row.customer.id, firstName: row.customer.firstName, lastName: row.customer.lastName, email: row.customer.email, phone: row.customer.phone },
    report: report ? { id: report.id, review: report.review, positive: report.positive, submittedAt: report.submittedAt } : null,
  };
}

export async function listAppointments(db: DbOrTx, q: { from?: string; to?: string; partnerId?: string; projectId?: string; status?: string }) {
  const filters: SQL[] = [];
  if (q.from) filters.push(gte(appointments.date, q.from));
  if (q.to) filters.push(lte(appointments.date, q.to));
  if (q.partnerId) filters.push(eq(appointments.partnerOrganizationId, q.partnerId));
  if (q.projectId) filters.push(eq(appointments.projectId, q.projectId));
  if (q.status) filters.push(eq(appointments.status, q.status as "planned"));
  const rows = await db
    .select({ a: appointments, project: projects, property: properties, customer: customers, partnerName: organizations.name, regionName: regions.name, groupName: productGroups.name })
    .from(appointments)
    .innerJoin(projects, eq(projects.id, appointments.projectId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .innerJoin(organizations, eq(organizations.id, appointments.partnerOrganizationId))
    .innerJoin(regions, eq(regions.id, appointments.regionId))
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(appointments.date))
    .limit(500);
  const ids = rows.map((r) => r.a.id);
  const reps = ids.length ? await db.select().from(reports).where(inArray(reports.appointmentId, ids)) : [];
  return rows.map((r) => toView(r, reps.find((x) => x.appointmentId === r.a.id) ?? null));
}

/** Projecten die klaarstaan om een schouw/installatie te plannen: status met overgang naar "{type}.scheduled". */
export async function toPlan(db: DbOrTx, type: AppointmentType) {
  const event = `${type}.scheduled`;
  const fromStatuses = await db
    .selectDistinct({ id: journeyTransitions.fromStatusId })
    .from(journeyTransitions)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, journeyTransitions.toStatusId))
    .where(sql`${event} = ANY(${journeyStatuses.autoOnEvents})`);
  if (!fromStatuses.length) return [];
  const rows = await db
    .select({ project: projects, property: properties, customer: customers, status: journeyStatuses, groupName: productGroups.name })
    .from(projects)
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .where(
      and(
        inArray(projects.statusId, fromStatuses.map((s) => s.id)),
        sql`not exists (select 1 from appointments a where a.project_id = ${projects.id} and a.type = ${type} and a.status = 'planned')`,
      ),
    )
    .orderBy(asc(projects.statusChangedAt));
  return rows.map((r) => ({
    projectId: r.project.id,
    projectNumber: formatProjectNumber(r.project.number),
    customerName: [r.customer.firstName, r.customer.lastName].filter(Boolean).join(" "),
    postalCode: r.property.postalCode,
    city: r.property.city,
    productGroupName: r.groupName,
    statusName: r.status.name,
    waitingSince: r.project.statusChangedAt,
    installationPartnerId: r.project.installationPartnerId,
  }));
}

/** Eerstvolgende geplande schouw van een project (voor de vervaldatum van de aanbetaling). */
export async function nextSurveyDate(db: DbOrTx, projectId: string) {
  const [a] = await db
    .select({ date: appointments.date })
    .from(appointments)
    .where(and(eq(appointments.projectId, projectId), eq(appointments.type, "survey"), eq(appointments.status, "planned")))
    .orderBy(asc(appointments.date))
    .limit(1);
  return a?.date ?? null;
}

// ---------------------------------------------------------------- Rapporten

export async function submitReport(
  db: Db,
  actor: ActorContext,
  appointmentId: string,
  input: { positive: boolean; data: ReportData; customerSignedName?: string | null; customerSignatureFileId?: string | null },
) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for("update");
    if (!a) throw notFound("Afspraak");
    if (actor.organizationId !== a.partnerOrganizationId && !actor.permissions.has("planning.manage")) throw forbidden();
    if (a.status !== "planned") throw conflict("not_planned", "Voor deze afspraak kan geen rapport meer worden ingediend");
    if (a.date > todayIso()) throw badRequest("too_early", "Een rapport kan pas op of na de afspraakdatum worden ingediend");
    if (a.type === "installation" && (!input.customerSignedName || !input.customerSignatureFileId)) {
      throw badRequest("signature_required", "Voor de oplevering is de handtekening van de klant verplicht");
    }
    if (input.data.extraWork?.length && a.type !== "survey") throw badRequest("extra_work_only_survey", "Meerwerk wordt bij de schouw voorgesteld");
    const [existing] = await tx.select().from(reports).where(eq(reports.appointmentId, appointmentId));
    if (existing) await tx.delete(reports).where(eq(reports.id, existing.id)); // opnieuw indienen na afkeuring
    const [r] = await tx
      .insert(reports)
      .values({ appointmentId, type: a.type, positive: input.positive, data: input.data, customerSignedName: input.customerSignedName ?? null, customerSignatureFileId: input.customerSignatureFileId ?? null, submittedBy: actor.userId })
      .returning();
    await tx.update(appointments).set({ status: "completed" }).where(eq(appointments.id, appointmentId));
    await recordAudit(tx, actor, { action: "report.submitted", entityType: "project", entityId: a.projectId, metadata: { appointmentId, type: a.type, positive: input.positive } });
    await emitEvent(tx, "report.submitted", { type: "report", id: r!.id }, { projectId: a.projectId, type: a.type });
    await emitJourneyEvent(tx, a.projectId, `${a.type}.report_submitted`);
    return r!;
  });
}

export async function getReport(db: DbOrTx, id: string) {
  const [r] = await db.select().from(reports).where(eq(reports.id, id));
  if (!r) throw notFound("Rapport");
  return { ...r, appointment: await getAppointment(db, r.appointmentId) };
}

export async function listReports(db: DbOrTx, q: { review?: "pending" | "approved" | "rejected"; projectId?: string }) {
  const filters: SQL[] = [];
  if (q.review) filters.push(eq(reports.review, q.review));
  if (q.projectId) filters.push(eq(appointments.projectId, q.projectId));
  const rows = await db
    .select({ r: reports, a: appointments })
    .from(reports)
    .innerJoin(appointments, eq(appointments.id, reports.appointmentId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(reports.submittedAt));
  return Promise.all(rows.map(async (row) => ({ ...row.r, appointment: await getAppointment(db, row.a.id) })));
}

/**
 * Gecko beoordeelt het rapport.
 * - Afgekeurd: de partner moet opnieuw indienen (afspraak gaat terug naar "gepland").
 * - Schouw goedgekeurd met meerwerk: er wordt een meerwerk-offerte (concept) gemaakt om te versturen.
 * - Schouw goedgekeurd zonder meerwerk / oplevering goedgekeurd: klantreis gaat verder.
 */
export async function reviewReport(db: Db, actor: ActorContext, id: string, input: { approve: boolean; note?: string | null }) {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(reports).where(eq(reports.id, id)).for("update");
    if (!r) throw notFound("Rapport");
    if (r.review !== "pending") throw conflict("already_reviewed", "Rapport is al beoordeeld");
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    await tx.update(reports).set({ review: input.approve ? "approved" : "rejected", reviewedBy: actor.userId, reviewedAt: new Date(), reviewNote: input.note ?? null }).where(eq(reports.id, id));
    await recordAudit(tx, actor, { action: input.approve ? "report.approved" : "report.rejected", entityType: "project", entityId: a!.projectId, metadata: { reportId: id, note: input.note } });

    let extraWorkQuoteId: string | null = null;
    if (!input.approve) {
      await tx.update(appointments).set({ status: "planned" }).where(eq(appointments.id, a!.id));
    } else if (r.type === "survey" && r.data.extraWork?.length) {
      extraWorkQuoteId = await createExtraWorkQuote(tx, actor, a!.projectId, r.data.extraWork);
    } else {
      await emitJourneyEvent(tx, a!.projectId, `${r.type}.report_approved`);
    }
    return { ...(await getReport(tx, id)), extraWorkQuoteId };
  });
}

/** Meerwerk-offerte (concept) uit het schouwrapport, met prijzen uit het verkoopkanaal van het project. */
async function createExtraWorkQuote(tx: DbOrTx, actor: ActorContext, projectId: string, lines: NonNullable<ReportData["extraWork"]>) {
  const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
  const [main] = await tx.select().from(quotes).where(and(eq(quotes.projectId, projectId), eq(quotes.kind, "main"), eq(quotes.status, "accepted")));
  if (!main) throw badRequest("no_main_quote", "Project heeft geen geaccepteerde hoofdofferte");
  const [q] = await tx
    .insert(quotes)
    .values({
      kind: "extra_work",
      customerId: p!.customerId,
      propertyId: p!.propertyId,
      productGroupId: p!.productGroupId,
      salesChannelId: p!.salesChannelId,
      advisorId: main.advisorId,
      installationPartnerId: p!.installationPartnerId,
      projectId,
      customerNote: "Meerwerk naar aanleiding van de schouw.",
      createdBy: actor.userId,
    })
    .returning();
  for (const l of lines) await addLineInTx(tx, actor, q!.id, { productId: l.productId, quantity: l.quantity, description: l.note ?? null });
  await recordAudit(tx, actor, { action: "quote.created", entityType: "quote", entityId: q!.id, after: { kind: "extra_work", projectId } });
  return q!.id;
}

