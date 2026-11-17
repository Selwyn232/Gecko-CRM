import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups, products } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import type { EmailTransport } from "../email/transport.js";
import { emitEvent } from "../events/service.js";
import { emitJourneyEvent } from "../journeys/auto.js";
import { journeyStatuses, journeyTransitions } from "../journeys/schema.js";
import { organizations } from "../organizations/schema.js";
import { assertPartnerHandlesGroup } from "../organizations/service.js";
import { projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { appointmentVars, sendTemplateMessage } from "../messages/service.js";
import { quotes } from "../quotes/schema.js";
import { addLineInTx } from "../quotes/service.js";
import { getSetting } from "../settings/service.js";
import { checkReport, getChecklist } from "../checklists/service.js";
import { listFiles } from "../files/storage.js";
import { invoices } from "../invoices/schema.js";
import { appointments, availabilityBlocks, partnerPenalties, partnerRegions, regions, reports, type ReportData, partnerProductGroups } from "./schema.js";

type AppointmentType = "survey" | "installation";
const TYPE_LABEL: Record<AppointmentType, string> = { survey: "schouw", installation: "installatie" };

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

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

// ---------------------------------------------------------------- Werkgebied en beschikbaarheid (blokken)

export type DayPart = "morning" | "afternoon";
const PARTS: DayPart[] = ["morning", "afternoon"];

export async function getPartnerRegions(db: DbOrTx, partnerId: string) {
  const rows = await db.select({ regionId: partnerRegions.regionId }).from(partnerRegions).where(eq(partnerRegions.partnerOrganizationId, partnerId));
  return rows.map((r) => r.regionId);
}

async function assertPartner(db: DbOrTx, partnerId: string) {
  const [partner] = await db.select().from(organizations).where(eq(organizations.id, partnerId));
  if (!partner || partner.type !== "installation_partner") throw badRequest("invalid_partner", "Organisatie is geen installatiepartner");
  return partner;
}

export async function setPartnerRegions(db: Db, actor: ActorContext, partnerId: string, regionIds: string[]) {
  await assertPartner(db, partnerId);
  const unique = [...new Set(regionIds)];
  await db.transaction(async (tx) => {
    const before = await getPartnerRegions(tx, partnerId);
    await tx.delete(partnerRegions).where(eq(partnerRegions.partnerOrganizationId, partnerId));
    if (unique.length) await tx.insert(partnerRegions).values(unique.map((regionId) => ({ partnerOrganizationId: partnerId, regionId })));
    await recordAudit(tx, actor, { action: "partner_regions.updated", entityType: "organization", entityId: partnerId, before: { regions: before.sort() }, after: { regions: unique.sort() } });
  });
  return getPartnerRegions(db, partnerId);
}

/** Welke blokken bezet zijn door afspraken: sleutel partner|datum|dagdeel → afspraak-id. */
/** Afspraken per blok ("partner|datum|dagdeel" → afspraak-id's). */
async function occupiedBlocks(db: DbOrTx, from: string, to: string, partnerId?: string) {
  const filters: SQL[] = [inArray(appointments.status, ["planned", "completed"]), lte(appointments.date, to), gte(sql`${appointments.date} + (${appointments.days} - 1)`, from)];
  if (partnerId) filters.push(eq(appointments.partnerOrganizationId, partnerId));
  const rows = await db.select().from(appointments).where(and(...filters));
  const map = new Map<string, string[]>();
  for (const a of rows) {
    for (let i = 0; i < a.days; i++) {
      const date = addDays(a.date, i);
      // Schouw: het gekozen dagdeel. Installatie (of "hele dag"): beide dagdelen.
      const parts: DayPart[] = a.timeWindow === "morning" || a.timeWindow === "afternoon" ? [a.timeWindow] : PARTS;
      for (const p of parts) {
        const key = `${a.partnerOrganizationId}|${date}|${p}`;
        map.set(key, [...(map.get(key) ?? []), a.id]);
      }
    }
  }
  return map;
}

/** Aantal ploegen per partner (capaciteit per beschikbaar dagdeel). */
async function crewCounts(db: DbOrTx, partnerIds?: string[]) {
  const rows = await db
    .select({ id: organizations.id, crews: organizations.crewCount })
    .from(organizations)
    .where(partnerIds ? inArray(organizations.id, partnerIds.length ? partnerIds : ["00000000-0000-0000-0000-000000000000"]) : eq(organizations.type, "installation_partner"));
  return new Map(rows.map((r) => [r.id, Math.max(1, r.crews)]));
}

export async function listAvailability(db: DbOrTx, q: { from: string; to: string; partnerId?: string }) {
  const filters: SQL[] = [gte(availabilityBlocks.date, q.from), lte(availabilityBlocks.date, q.to)];
  if (q.partnerId) filters.push(eq(availabilityBlocks.partnerOrganizationId, q.partnerId));
  const rows = await db.select().from(availabilityBlocks).where(and(...filters)).orderBy(asc(availabilityBlocks.date));
  const occupied = await occupiedBlocks(db, q.from, q.to, q.partnerId);
  const crews = await crewCounts(db, [...new Set(rows.map((r) => r.partnerOrganizationId))]);
  return rows.map((r) => {
    const ids = occupied.get(`${r.partnerOrganizationId}|${r.date}|${r.part}`) ?? [];
    return {
      partnerOrganizationId: r.partnerOrganizationId,
      date: r.date,
      part: r.part,
      /** Eerste afspraak in dit blok (een blok met afspraken kan niet worden uitgezet). */
      appointmentId: ids[0] ?? null,
      appointmentCount: ids.length,
      capacity: crews.get(r.partnerOrganizationId) ?? 1,
    };
  });
}

export interface BlockChange {
  date: string;
  part: DayPart;
  available: boolean;
}

/** Blokken aan- of uitzetten. Een blok met een afspraak kan niet worden uitgezet. */
export async function setAvailability(db: Db, actor: ActorContext, partnerId: string, changes: BlockChange[]) {
  await assertPartner(db, partnerId);
  const today = todayIso();
  await db.transaction(async (tx) => {
    for (const c of changes) {
      if (c.date < today) throw badRequest("date_in_past", "Beschikbaarheid in het verleden kan niet worden gewijzigd");
      if (c.available) {
        await tx.insert(availabilityBlocks).values({ partnerOrganizationId: partnerId, date: c.date, part: c.part }).onConflictDoNothing();
      } else {
        const occupied = (await occupiedBlocks(tx, c.date, c.date, partnerId)).get(`${partnerId}|${c.date}|${c.part}`)?.length;
        if (occupied) throw conflict("block_in_use", `Op ${c.date} (${c.part === "morning" ? "ochtend" : "middag"}) staat al een afspraak; dit blok kan niet worden uitgezet`);
        await tx
          .delete(availabilityBlocks)
          .where(and(eq(availabilityBlocks.partnerOrganizationId, partnerId), eq(availabilityBlocks.date, c.date), eq(availabilityBlocks.part, c.part)));
      }
    }
    await recordAudit(tx, actor, { action: "availability.updated", entityType: "organization", entityId: partnerId, metadata: { changes: changes.length } });
  });
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

/** Partners die in (een van) deze regio's werken. */
async function partnersForRegions(db: DbOrTx, regionIds: string[]) {
  if (!regionIds.length) return [];
  return db
    .selectDistinct({ id: organizations.id, name: organizations.name, regionId: partnerRegions.regionId })
    .from(partnerRegions)
    .innerJoin(organizations, eq(organizations.id, partnerRegions.partnerOrganizationId))
    .where(and(inArray(partnerRegions.regionId, regionIds), eq(organizations.isActive, true), eq(organizations.type, "installation_partner")));
}

export interface Slot {
  date: string;
  part: DayPart | null;
  partnerId: string;
  partnerName: string;
  regionId: string;
  days: number;
}

export async function findSlots(db: DbOrTx, projectId: string, type: AppointmentType) {
  const ctx = await projectContext(db, projectId);
  const regs = await regionsForPostal(db, ctx.property.postalCode);
  if (!regs.length) return { regions: [], slots: [] as Slot[], message: `Postcode ${ctx.property.postalCode} valt in geen enkele regio. Voeg hem toe bij Regio's.` };
  let partners = await partnersForRegions(db, regs.map((r) => r.id));
  // Alleen partners die deze productgroep installeren (geen productgroepen ingesteld = alle).
  const groupRows = partners.length
    ? await db.select().from(partnerProductGroups).where(inArray(partnerProductGroups.partnerOrganizationId, [...new Set(partners.map((p) => p.id))]))
    : [];
  const handles = (pid: string) => {
    const own = groupRows.filter((r) => r.partnerOrganizationId === pid);
    return !own.length || own.some((r) => r.productGroupId === ctx.project.productGroupId);
  };
  const inRegion = partners.length;
  partners = partners.filter((p) => handles(p.id));
  // Installatie bij dezelfde partner als de schouw (die kent de situatie en is verantwoordelijk voor gemist meerwerk).
  if (type === "installation" && ctx.project.installationPartnerId) partners = partners.filter((p) => p.id === ctx.project.installationPartnerId);
  if (!partners.length) {
    return {
      regions: regs.map((r) => ({ id: r.id, name: r.name })),
      slots: [],
      message: inRegion
        ? `Geen installatiepartner in deze regio installeert ${ctx.group.name.toLowerCase()}. Stel de productgroepen in bij Organisaties.`
        : "Geen installatiepartner werkt in deze regio. Stel het werkgebied in bij Beschikbaarheid.",
    };
  }

  // In testmodus mag vandaag al worden gepland.
  const lead = (await getSetting(db, "test.mode")) ? 0 : await getSetting(db, type === "survey" ? "planning.survey_lead_days" : "planning.installation_lead_days");
  const horizon = await getSetting(db, "planning.horizon_days");
  const from = addDays(todayIso(), lead);
  const to = addDays(todayIso(), horizon);
  const days = type === "installation" ? ctx.group.installationDays : 1;
  const partnerIds = [...new Set(partners.map((p) => p.id))];

  const blocks = await db
    .select()
    .from(availabilityBlocks)
    .where(and(inArray(availabilityBlocks.partnerOrganizationId, partnerIds), gte(availabilityBlocks.date, from), lte(availabilityBlocks.date, addDays(to, days + 14))));
  const occupied = await occupiedBlocks(db, from, addDays(to, days + 14));
  const crews = await crewCounts(db, partnerIds);
  // Vrij = minder afspraken in het blok dan de partner ploegen heeft.
  const free = new Set(
    blocks
      .filter((b) => (occupied.get(`${b.partnerOrganizationId}|${b.date}|${b.part}`)?.length ?? 0) < (crews.get(b.partnerOrganizationId) ?? 1))
      .map((b) => `${b.partnerOrganizationId}|${b.date}|${b.part}`),
  );
  const isFree = (pid: string, date: string, part: DayPart) => free.has(`${pid}|${date}|${part}`);
  /** Volgende dag waarop de partner beschikbaar is (een meerdaagse installatie loopt over werkdagen door). */
  const workDays = (pid: string, start: string) => {
    const dates = [...new Set(blocks.filter((b) => b.partnerOrganizationId === pid && b.date >= start).map((b) => b.date))].sort();
    return dates.slice(0, days);
  };

  const slots: Slot[] = [];
  for (const pid of partnerIds) {
    const partner = partners.find((p) => p.id === pid)!;
    const regionId = partners.find((p) => p.id === pid && regs.some((r) => r.id === p.regionId))!.regionId;
    const dates = [...new Set(blocks.filter((b) => b.partnerOrganizationId === pid && b.date <= to).map((b) => b.date))].sort();
    for (const date of dates) {
      if (type === "survey") {
        for (const part of PARTS) if (isFree(pid, date, part)) slots.push({ date, part, partnerId: pid, partnerName: partner.name, regionId, days: 1 });
      } else {
        // Installatie: beide dagdelen vrij op deze dag én de volgende beschikbare dagen.
        const span = workDays(pid, date);
        if (span.length === days && span[0] === date && span.every((d) => isFree(pid, d, "morning") && isFree(pid, d, "afternoon"))) {
          slots.push({ date, part: null, partnerId: pid, partnerName: partner.name, regionId, days });
        }
      }
    }
  }
  const partOrder = (p: DayPart | null) => (p === "afternoon" ? 1 : 0);
  slots.sort((a, b) => a.date.localeCompare(b.date) || partOrder(a.part) - partOrder(b.part) || a.partnerName.localeCompare(b.partnerName));
  return { regions: regs.map((r) => ({ id: r.id, name: r.name })), slots, message: slots.length ? null : "Geen vrije blokken gevonden in deze periode." };
}

/**
 * Planvoorstel: de beste momenten uit de vrije blokken, met uitleg. Weging (lager = beter):
 * - hoe snel (dagen na het eerste vrije moment),
 * - drukte van de partner (afspraken komende 14 dagen; spreidt het werk),
 * - bonus als de partner die dag al in dezelfde buurt (PC2) is: minder reistijd.
 * Een voorstel; de planner bevestigt.
 */
export async function suggestSlots(db: DbOrTx, projectId: string, type: AppointmentType) {
  const found = await findSlots(db, projectId, type);
  if (!found.slots.length) return { ...found, suggestions: [] };
  const ctx = await projectContext(db, projectId);
  const pc2 = ctx.property.postalCode.replace(/\D/g, "").slice(0, 2);
  const today = todayIso();
  const partnerIds = [...new Set(found.slots.map((s) => s.partnerId))];
  const planned = await db
    .select({ partnerId: appointments.partnerOrganizationId, date: appointments.date, postalCode: properties.postalCode })
    .from(appointments)
    .innerJoin(projects, eq(projects.id, appointments.projectId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .where(and(inArray(appointments.partnerOrganizationId, partnerIds), eq(appointments.status, "planned"), gte(appointments.date, today)));
  const horizon = addDays(today, 14);
  const load = new Map(partnerIds.map((id) => [id, planned.filter((p) => p.partnerId === id && p.date <= horizon).length]));
  const first = found.slots[0]!.date;
  const scored = found.slots.map((s) => {
    const offset = Math.round((Date.parse(s.date) - Date.parse(first)) / 86_400_000);
    const nearby = planned.some((p) => p.partnerId === s.partnerId && p.date === s.date && p.postalCode.replace(/\D/g, "").slice(0, 2) === pc2);
    const l = load.get(s.partnerId) ?? 0;
    const reasons: string[] = [];
    if (offset === 0) reasons.push("Eerste vrije moment");
    else reasons.push(`${offset} dag${offset === 1 ? "" : "en"} na het eerste vrije moment`);
    if (nearby) reasons.push(`Partner is die dag al in de buurt (postcode ${pc2}..)`);
    reasons.push(l === 0 ? "Partner heeft de komende 2 weken nog niets gepland" : `Partner heeft ${l} afspraak${l === 1 ? "" : "en"} in de komende 2 weken`);
    return { ...s, score: offset + l * 0.5 - (nearby ? 3 : 0), reasons };
  });
  scored.sort((a, b) => a.score - b.score || a.date.localeCompare(b.date));
  return { ...found, suggestions: scored.slice(0, 3) };
}

// ---------------------------------------------------------------- Afspraken

export async function scheduleAppointment(
  db: Db,
  transport: EmailTransport | null,
  actor: ActorContext,
  projectId: string,
  input: { type: AppointmentType; date: string; partnerId: string; part?: DayPart | null; notes?: string | null },
) {
  const appointment = await db.transaction(async (tx) => {
    const ctx = await projectContext(tx, projectId);
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (input.type === "installation" && project!.installationPartnerId && project!.installationPartnerId !== input.partnerId) {
      throw badRequest("partner_mismatch", "De installatie moet bij dezelfde partner als de schouw");
    }
    if (input.type === "survey" && !input.part) throw badRequest("part_required", "Kies ochtend of middag voor de schouw");
    const [existing] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.projectId, projectId), eq(appointments.type, input.type), eq(appointments.status, "planned")));
    if (existing) throw conflict("already_planned", `Er staat al een ${TYPE_LABEL[input.type]} gepland; verzet of annuleer die eerst`);
    const regs = await regionsForPostal(tx, ctx.property.postalCode);
    const partnerRegs = await getPartnerRegions(tx, input.partnerId);
    const region = regs.find((r) => partnerRegs.includes(r.id));
    if (!region) throw badRequest("region_mismatch", "Deze partner werkt niet in de regio van dit adres");
    await assertPartnerHandlesGroup(tx, input.partnerId, ctx.project.productGroupId);

    // Benodigde blokken bepalen en vergrendelen (voorkomt dubbel boeken bij gelijktijdig plannen).
    const days = input.type === "installation" ? ctx.group.installationDays : 1;
    let dates = [input.date];
    if (days > 1) {
      const avail = await tx
        .selectDistinct({ date: availabilityBlocks.date })
        .from(availabilityBlocks)
        .where(and(eq(availabilityBlocks.partnerOrganizationId, input.partnerId), gte(availabilityBlocks.date, input.date)))
        .orderBy(asc(availabilityBlocks.date))
        .limit(days);
      dates = avail.map((d) => d.date);
      if (dates.length < days || dates[0] !== input.date) throw conflict("no_capacity", "Niet genoeg beschikbare dagen voor deze installatie");
    }
    const parts: DayPart[] = input.type === "survey" ? [input.part!] : PARTS;
    for (const date of dates) {
      for (const part of parts) {
        const [block] = await tx
          .select()
          .from(availabilityBlocks)
          .where(and(eq(availabilityBlocks.partnerOrganizationId, input.partnerId), eq(availabilityBlocks.date, date), eq(availabilityBlocks.part, part)))
          .for("update");
        if (!block) throw conflict("no_capacity", `Partner is niet beschikbaar op ${date} (${part === "morning" ? "ochtend" : "middag"})`);
        const inBlock = (await occupiedBlocks(tx, date, date, input.partnerId)).get(`${input.partnerId}|${date}|${part}`)?.length ?? 0;
        if (inBlock >= ((await crewCounts(tx, [input.partnerId])).get(input.partnerId) ?? 1)) {
          throw conflict("no_capacity", `Blok op ${date} (${part === "morning" ? "ochtend" : "middag"}) is al bezet`);
        }
      }
    }
    // Meerdaagse installatie: aantal kalenderdagen tot en met de laatste werkdag.
    const spanDays = days > 1 ? Math.round((Date.parse(dates.at(-1)!) - Date.parse(dates[0]!)) / 86_400_000) + 1 : 1;

    const [row] = await tx
      .insert(appointments)
      .values({
        projectId,
        partnerOrganizationId: input.partnerId,
        regionId: region.id,
        type: input.type,
        date: input.date,
        days: spanDays,
        timeWindow: input.type === "survey" ? input.part! : "day",
        notes: input.notes ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!project!.installationPartnerId) await tx.update(projects).set({ installationPartnerId: input.partnerId }).where(eq(projects.id, projectId));
    await recordAudit(tx, actor, { action: "appointment.scheduled", entityType: "project", entityId: projectId, after: { type: input.type, date: input.date, part: input.part ?? "day", partnerId: input.partnerId } });
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
    if (input.partnerNoShow) {
      const amount = await getSetting(tx, "planning.no_show_penalty_cents");
      const [pen] = await tx
        .insert(partnerPenalties)
        .values({ partnerOrganizationId: a.partnerOrganizationId, appointmentId: id, amountCents: amount, reason: `Niet gekomen op ${a.date}: ${input.reason}`, createdBy: actor.userId })
        .returning();
      await recordAudit(tx, actor, { action: "penalty.created", entityType: "organization", entityId: a.partnerOrganizationId, after: pen });
    }
  });
  if (input.notifyCustomer !== false) await notifyCustomer(db, transport, id, "canceled");
  return getAppointment(db, id);
}

async function notifyCustomer(db: Db, transport: EmailTransport | null, appointmentId: string, kind: "scheduled" | "canceled") {
  const a = await getAppointment(db, appointmentId);
  const key = kind === "canceled" ? "appointment.canceled" : a.type === "survey" ? "appointment.scheduled.survey" : "appointment.scheduled.installation";
  await sendTemplateMessage(db, transport, { key }, {
    to: a.customer.email,
    customerId: a.customer.id,
    related: { type: "appointment", id: a.id },
    vars: appointmentVars(a),
  });
}

/**
 * Herinnering de dag vóór een geplande afspraak (bij meerdaagse installaties: vóór de eerste dag).
 * Vanaf 9:00 Nederlandse tijd; per afspraak en datum hooguit één keer (ook na verzetten opnieuw).
 */
export async function sendAppointmentReminders(db: Db, transport: EmailTransport | null, now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false }).format(now));
  if (hour < 9) return { sent: 0 };
  const tomorrow = addDays(todayIso(now), 1);
  const due = await db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.status, "planned"), eq(appointments.date, tomorrow)));
  let sent = 0;
  for (const { id } of due) {
    const a = await getAppointment(db, id);
    const r = await sendTemplateMessage(db, transport, { key: a.type === "survey" ? "appointment.reminder.survey" : "appointment.reminder.installation" }, {
      to: a.customer.email,
      customerId: a.customer.id,
      related: { type: "appointment", id: a.id },
      vars: appointmentVars(a),
      dedupeKey: `appointment.reminder:${a.id}:${a.date}`,
    });
    if (r) sent++;
  }
  return { sent };
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
  const flags = await depositFlags(db, [row.a]);
  return { ...toView(row, report ?? null), depositUnpaid: flags.has(row.a.id) };
}

/**
 * Signalering (O11): geplande schouwen waarvoor de aanbetaling nog niet is voldaan.
 * Geeft de id's van de betreffende afspraken terug.
 */
async function depositFlags(db: DbOrTx, appts: (typeof appointments.$inferSelect)[]) {
  const surveys = appts.filter((a) => a.type === "survey" && a.status === "planned");
  if (!surveys.length) return new Set<string>();
  const deposits = await db
    .select({ projectId: invoices.projectId, status: invoices.status })
    .from(invoices)
    .where(and(inArray(invoices.projectId, surveys.map((s) => s.projectId)), eq(invoices.type, "deposit")));
  const paid = new Set(deposits.filter((d) => d.status === "paid").map((d) => d.projectId));
  return new Set(surveys.filter((s) => !paid.has(s.projectId)).map((s) => s.id));
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
  const flags = await depositFlags(db, rows.map((r) => r.a));
  return rows.map((r) => ({ ...toView(r, reps.find((x) => x.appointmentId === r.a.id) ?? null), depositUnpaid: flags.has(r.a.id) }));
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
    if (a.date > todayIso() && !(await getSetting(tx, "test.mode"))) {
      throw badRequest("too_early", "Een rapport kan pas op of na de afspraakdatum worden ingediend");
    }
    if (a.type === "installation" && (!input.customerSignedName || !input.customerSignatureFileId)) {
      throw badRequest("signature_required", "Voor de oplevering is de handtekening van de klant verplicht");
    }
    if (input.data.extraWork?.length && a.type !== "survey") throw badRequest("extra_work_only_survey", "Meerwerk wordt bij de schouw voorgesteld");
    if (input.data.extraWork?.length) {
      // Alleen actief meerwerk uit de catalogus van deze productgroep.
      const [proj] = await tx.select({ productGroupId: projects.productGroupId }).from(projects).where(eq(projects.id, a.projectId));
      const ids = [...new Set(input.data.extraWork.map((x) => x.productId))];
      const ok = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(inArray(products.id, ids), eq(products.type, "extra_work"), eq(products.isActive, true), eq(products.productGroupId, proj!.productGroupId)));
      if (ok.length !== ids.length) throw badRequest("invalid_extra_work", "Kies meerwerk uit de lijst voor deze productgroep");
    }
    if (input.positive) {
      const [proj] = await tx.select({ productGroupId: projects.productGroupId }).from(projects).where(eq(projects.id, a.projectId));
      const photos = (await listFiles(tx, "appointment", appointmentId)).filter((f) => f.contentType.startsWith("image/") && f.id !== input.customerSignatureFileId).length;
      checkReport(await getChecklist(tx, proj!.productGroupId, a.type as "survey" | "installation"), input.data.checklist, photos);
    }
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
    await recordAudit(tx, actor, { action: input.approve ? "report.approved" : "report.rejected", entityType: "project", entityId: a!.projectId, metadata: { reportId: id, appointmentId: r.appointmentId, note: input.note } });

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

// ---------------------------------------------------------------- Sancties

export async function listPenalties(db: DbOrTx, q: { partnerId?: string; status?: "open" | "settled" | "waived" }) {
  const filters: SQL[] = [];
  if (q.partnerId) filters.push(eq(partnerPenalties.partnerOrganizationId, q.partnerId));
  if (q.status) filters.push(eq(partnerPenalties.status, q.status));
  const rows = await db
    .select({ penalty: partnerPenalties, partnerName: organizations.name })
    .from(partnerPenalties)
    .innerJoin(organizations, eq(organizations.id, partnerPenalties.partnerOrganizationId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(partnerPenalties.createdAt));
  return rows.map((r) => ({ ...r.penalty, partnerName: r.partnerName }));
}

/** Sanctie kwijtschelden (bv. bij overmacht), met reden. */
export async function waivePenalty(db: Db, actor: ActorContext, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(partnerPenalties).where(eq(partnerPenalties.id, id)).for("update");
    if (!p) throw notFound("Sanctie");
    if (p.status !== "open") throw conflict("penalty_not_open", "Alleen een openstaande sanctie kan worden kwijtgescholden");
    const [after] = await tx.update(partnerPenalties).set({ status: "waived", waivedReason: reason }).where(eq(partnerPenalties.id, id)).returning();
    await recordAudit(tx, actor, { action: "penalty.waived", entityType: "organization", entityId: p.partnerOrganizationId, before: p, after });
    return after!;
  });
}

