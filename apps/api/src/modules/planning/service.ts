import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups, products, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import type { EmailTransport } from "../email/transport.js";
import { emitEvent } from "../events/service.js";
import { emitJourneyEvent } from "../journeys/auto.js";
import { journeyStatuses, journeyTransitions } from "../journeys/schema.js";
import { journeyHasSurvey } from "../journeys/service.js";
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
import { users } from "../auth/schema.js";
import { appointments, partnerPenalties, partnerRegions, regions, reports, technicianAvailability, type ReportData, partnerProductGroups } from "./schema.js";
import { arrivalText, DAY_END, DAY_START, hhmm } from "./time.js";
import { travelKey, travelMatrix } from "./travel.js";

export type AppointmentType = "survey" | "installation";
const TYPE_LABEL: Record<AppointmentType | "service", string> = { survey: "schouw", installation: "installatie", service: "service" };

// ---------------------------------------------------------------- B87: monteurs en 2-uursblokken

/** Werkdag 08:00–16:00 in vier blokken van 2 uur. Tijden in minuten na middernacht. */
export { DAY_START, DAY_END, hhmm, arrivalText };
export const SLOT_MINUTES = 120;
export const SLOT_KEYS = ["08", "10", "12", "14"] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
const slotStart = (i: number) => DAY_START + i * SLOT_MINUTES;
const slotIndex = (key: string) => SLOT_KEYS.indexOf(key as SlotKey);

/** Duur per soort klus (B87): service en schouw 2 uur, installatie 6 uur per dag. */
export function durationFor(type: AppointmentType | "service", installationDays: number) {
  if (type === "installation") return { minutes: 360, days: Math.max(1, installationDays) };
  return { minutes: 120, days: 1 };
}

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

/** Monteurs (actief) van deze partners. */
export async function techniciansOf(db: DbOrTx, partnerIds: string[]) {
  if (!partnerIds.length) return [];
  return db
    .select({ id: users.id, name: users.name, partnerId: users.organizationId })
    .from(users)
    .where(and(inArray(users.organizationId, partnerIds), eq(users.isTechnician, true), eq(users.isActive, true)))
    .orderBy(asc(users.name));
}

async function assertTechnician(db: DbOrTx, partnerId: string, technicianId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, technicianId));
  if (!u || u.organizationId !== partnerId || !u.isTechnician) throw badRequest("invalid_technician", "Deze monteur hoort niet bij deze partner");
  return u;
}

/** Klussen van monteurs in een periode (gepland of uitgevoerd), met de postcode van het adres. */
async function technicianJobs(db: DbOrTx, technicianIds: string[], from: string, to: string) {
  if (!technicianIds.length) return [];
  const rows = await db
    .select({ a: appointments, postalCode: properties.postalCode })
    .from(appointments)
    .innerJoin(projects, eq(projects.id, appointments.projectId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .where(
      and(
        inArray(appointments.technicianUserId, technicianIds),
        inArray(appointments.status, ["planned", "completed"]),
        lte(appointments.date, to),
        gte(sql`${appointments.date} + (${appointments.days} - 1)`, from),
      ),
    );
  // Per dag een regel (meerdaagse installatie: elke dag dezelfde tijden).
  const out: { id: string; technicianId: string; date: string; start: number; end: number; postalCode: string }[] = [];
  for (const r of rows) {
    const start = r.a.startMinute ?? DAY_START;
    const end = start + (r.a.durationMinutes ?? (r.a.type === "installation" ? 360 : 120));
    for (let d = 0; d < r.a.days; d++) out.push({ id: r.a.id, technicianId: r.a.technicianUserId!, date: addDays(r.a.date, d), start, end, postalCode: r.postalCode });
  }
  return out;
}

export async function listAvailability(db: DbOrTx, q: { from: string; to: string; partnerId?: string; technicianId?: string }) {
  const techIds = q.technicianId ? [q.technicianId] : q.partnerId ? (await techniciansOf(db, [q.partnerId])).map((t) => t.id) : [];
  if (!techIds.length) return [];
  const rows = await db
    .select()
    .from(technicianAvailability)
    .where(and(inArray(technicianAvailability.technicianUserId, techIds), gte(technicianAvailability.date, q.from), lte(technicianAvailability.date, q.to)))
    .orderBy(asc(technicianAvailability.date), asc(technicianAvailability.slot));
  const jobs = await technicianJobs(db, techIds, q.from, q.to);
  return rows.map((r) => {
    const s0 = slotStart(r.slot);
    const inSlot = jobs.filter((j) => j.technicianId === r.technicianUserId && j.date === r.date && j.start < s0 + SLOT_MINUTES && j.end > s0);
    return {
      technicianId: r.technicianUserId,
      date: r.date,
      part: SLOT_KEYS[r.slot]!,
      /** Eerste klus in dit blok (een blok met een klus kan niet worden uitgezet). */
      appointmentId: inSlot[0]?.id ?? null,
      appointmentCount: inSlot.length,
      capacity: 1,
    };
  });
}

export interface BlockChange {
  date: string;
  part: string;
  available: boolean;
}

/** 2-uursblokken van een monteur aan- of uitzetten. Een blok met een klus kan niet worden uitgezet. */
export async function setAvailability(db: Db, actor: ActorContext, partnerId: string, technicianId: string, changes: BlockChange[]) {
  await assertPartner(db, partnerId);
  await assertTechnician(db, partnerId, technicianId);
  const today = todayIso();
  await db.transaction(async (tx) => {
    for (const c of changes) {
      const slot = slotIndex(c.part);
      if (slot < 0) throw badRequest("invalid_slot", "Onbekend blok; kies 08, 10, 12 of 14");
      if (c.date < today) throw badRequest("date_in_past", "Beschikbaarheid in het verleden kan niet worden gewijzigd");
      if (c.available) {
        await tx.insert(technicianAvailability).values({ technicianUserId: technicianId, date: c.date, slot }).onConflictDoNothing();
      } else {
        const s0 = slotStart(slot);
        const busy = (await technicianJobs(tx, [technicianId], c.date, c.date)).some((j) => j.date === c.date && j.start < s0 + SLOT_MINUTES && j.end > s0);
        if (busy) throw conflict("block_in_use", `Op ${c.date} (${hhmm(s0)}–${hhmm(s0 + SLOT_MINUTES)}) staat al een klus; dit blok kan niet worden uitgezet`);
        await tx
          .delete(technicianAvailability)
          .where(and(eq(technicianAvailability.technicianUserId, technicianId), eq(technicianAvailability.date, c.date), eq(technicianAvailability.slot, slot)));
      }
    }
    await recordAudit(tx, actor, { action: "availability.updated", entityType: "organization", entityId: partnerId, metadata: { technicianId, changes: changes.length } });
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
  /** Starttijd in minuten na middernacht (bv. 480 = 08:00). */
  startMinute: number;
  endMinute: number;
  /** Tekst voor op het scherm, bv. "10:30–12:30". */
  time: string;
  technicianId: string;
  technicianName: string;
  partnerId: string;
  partnerName: string;
  regionId: string;
  days: number;
  /** Rijtijd vanaf de vorige klus die dag (null = eerste klus van de dag). */
  travelBefore: number | null;
  /** Rijtijd naar de volgende klus die dag (null = geen volgende klus). */
  travelAfter: number | null;
  /** Oud veld (dagdeel); niet meer gebruikt. */
  part: null;
}

/** B86: plannen (schouw of installatie) kan alleen met een geaccepteerde offerte. */
const SIGNED = (projectIdCol: unknown) =>
  sql`exists (select 1 from quotes q where q.project_id = ${projectIdCol} and q.kind = 'main' and q.status = 'accepted')`;

async function assertSignedQuote(db: DbOrTx, projectId: string) {
  const [q] = await db.select({ id: quotes.id }).from(quotes).where(and(eq(quotes.projectId, projectId), eq(quotes.kind, "main"), eq(quotes.status, "accepted"))).limit(1);
  if (!q) throw badRequest("no_accepted_quote", "Inplannen kan pas als de klant akkoord heeft gegeven op de offerte");
}

export async function findSlots(db: DbOrTx, projectId: string, type: AppointmentType, only?: { technicianId: string; date: string }) {
  const ctx = await projectContext(db, projectId);
  await assertSignedQuote(db, projectId);
  if (type === "survey" && !(await journeyHasSurvey(db, ctx.project.statusId))) throw badRequest("no_survey_in_journey", "De klantreis van dit project heeft geen schouw; plan direct de installatie");
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
  const regionsOut = regs.map((r) => ({ id: r.id, name: r.name }));
  if (!partners.length) {
    return {
      regions: regionsOut,
      slots: [] as Slot[],
      message: inRegion
        ? `Geen installatiepartner in deze regio installeert ${ctx.group.name.toLowerCase()}. Stel de productgroepen in bij Organisaties.`
        : "Geen installatiepartner werkt in deze regio. Stel het werkgebied in bij Beschikbaarheid.",
    };
  }

  // In testmodus mag vandaag al worden gepland.
  const testMode = Boolean(await getSetting(db, "test.mode"));
  const lead = testMode ? 0 : await getSetting(db, type === "survey" ? "planning.survey_lead_days" : "planning.installation_lead_days");
  const horizon = await getSetting(db, "planning.horizon_days");
  let from = addDays(todayIso(), lead);
  let to = addDays(todayIso(), horizon);
  // B82: per verkoopkanaal een aanlooptijd voor de installatie, gerekend vanaf binnenkomst van de order (niet in testmodus).
  if (type === "installation" && !testMode) {
    const [ch] = await db.select({ days: salesChannels.installationLeadDays }).from(salesChannels).where(eq(salesChannels.id, ctx.project.salesChannelId));
    if (ch?.days) {
      const channelFrom = addDays(ctx.project.createdAt.toISOString().slice(0, 10), ch.days);
      if (channelFrom > from) {
        from = channelFrom;
        if (to < addDays(from, 28)) to = addDays(from, 28);
      }
    }
  }
  if (only) {
    if (only.date < from || only.date > to) return { regions: regionsOut, slots: [] as Slot[], message: "Deze datum valt buiten de planbare periode." };
    from = only.date;
    to = only.date;
  }
  const { minutes: dur, days } = durationFor(type, ctx.group.installationDays);
  const partnerIds = [...new Set(partners.map((p) => p.id))];
  let techs = await techniciansOf(db, partnerIds);
  if (only) techs = techs.filter((t) => t.id === only.technicianId);
  if (!techs.length) return { regions: regionsOut, slots: [] as Slot[], message: "Deze partner(s) hebben nog geen monteurs. Voeg monteurs toe in het partnerportaal." };
  const techIds = techs.map((t) => t.id);
  const until = addDays(to, days + 14);
  const avail = await db
    .select()
    .from(technicianAvailability)
    .where(and(inArray(technicianAvailability.technicianUserId, techIds), gte(technicianAvailability.date, from), lte(technicianAvailability.date, until)));
  const availSet = new Set(avail.map((a) => `${a.technicianUserId}|${a.date}|${a.slot}`));
  const jobs = await technicianJobs(db, techIds, from, until);

  // Rijtijden tussen dit adres en de andere klussen van deze monteurs (Google Maps, met geheugen).
  const here = ctx.property.postalCode;
  const others = [...new Set(jobs.map((j) => j.postalCode))];
  const toHere = await travelMatrix(db, others, [here]);
  const fromHere = await travelMatrix(db, [here], others);
  const tBefore = (pc: string) => toHere.get(travelKey(pc, here)) ?? 30;
  const tAfter = (pc: string) => fromHere.get(travelKey(here, pc)) ?? 30;

  const covered = (tech: string, date: string, start: number, end: number) => {
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const s0 = slotStart(i);
      if (s0 < end && s0 + SLOT_MINUTES > start && !availSet.has(`${tech}|${date}|${i}`)) return false;
    }
    return start >= DAY_START && end <= DAY_END;
  };
  /** Past de klus op deze dag en dit tijdstip, inclusief rijtijd van de vorige en naar de volgende klus? */
  const fits = (tech: string, date: string, start: number) => {
    const end = start + dur;
    if (!covered(tech, date, start, end)) return null;
    let before: number | null = null;
    let after: number | null = null;
    for (const j of jobs) {
      if (j.technicianId !== tech || j.date !== date) continue;
      if (j.end <= start) {
        const t = tBefore(j.postalCode);
        if (j.end + t > start) return null;
        if (before === null || t < before) before = t;
      } else if (j.start >= end) {
        const t = tAfter(j.postalCode);
        if (end + t > j.start) return null;
        if (after === null || t < after) after = t;
      } else return null;
    }
    return { before, after };
  };
  const techDates = (tech: string) => [...new Set(avail.filter((a) => a.technicianUserId === tech).map((a) => a.date))].sort();

  const slots: Slot[] = [];
  for (const t of techs) {
    const partner = partners.find((p) => p.id === t.partnerId)!;
    const regionId = partners.find((p) => p.id === t.partnerId && regs.some((r) => r.id === p.regionId))!.regionId;
    const dates = techDates(t.id);
    for (const date of dates.filter((d) => d <= to)) {
      // Mogelijke starttijden: begin van elk blok, of direct na een eerdere klus + rijtijd (op 15 minuten).
      const starts = new Set<number>(SLOT_KEYS.map((_, i) => slotStart(i)));
      for (const j of jobs) if (j.technicianId === t.id && j.date === date) starts.add(Math.ceil((j.end + tBefore(j.postalCode)) / 15) * 15);
      // Meerdaagse installatie: dezelfde tijd op de volgende beschikbare dagen van de monteur.
      const span = days > 1 ? dates.filter((d) => d >= date).slice(0, days) : [date];
      if (span.length < days) continue;
      for (const start of [...starts].sort((a, b) => a - b)) {
        const day1 = fits(t.id, date, start);
        if (!day1) continue;
        if (!span.slice(1).every((d) => fits(t.id, d, start))) continue;
        slots.push({
          date,
          startMinute: start,
          endMinute: start + dur,
          time: `${hhmm(start)}–${hhmm(start + dur)}`,
          technicianId: t.id,
          technicianName: t.name,
          partnerId: t.partnerId!,
          partnerName: partner.name,
          regionId,
          days: span.length > 1 ? Math.round((Date.parse(span.at(-1)!) - Date.parse(date)) / 86_400_000) + 1 : 1,
          travelBefore: day1.before,
          travelAfter: day1.after,
          part: null,
        });
      }
    }
  }
  slots.sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute || a.technicianName.localeCompare(b.technicianName));
  return { regions: regionsOut, slots, message: slots.length ? null : "Geen vrije momenten gevonden in deze periode." };
}

/**
 * Planvoorstel: de beste momenten, met uitleg. Weging (lager = beter):
 * - hoe snel (dagen na het eerste vrije moment),
 * - rijtijd: past de klus tussen klussen in de buurt, dan minder reistijd,
 * - drukte van de partner (spreidt het werk).
 * Een voorstel; de planner bevestigt.
 */
export async function suggestSlots(db: DbOrTx, projectId: string, type: AppointmentType) {
  const found = await findSlots(db, projectId, type);
  if (!found.slots.length) return { ...found, suggestions: [] };
  const today = todayIso();
  const partnerIds = [...new Set(found.slots.map((s) => s.partnerId))];
  const planned = await db
    .select({ partnerId: appointments.partnerOrganizationId, date: appointments.date })
    .from(appointments)
    .where(and(inArray(appointments.partnerOrganizationId, partnerIds), eq(appointments.status, "planned"), gte(appointments.date, today)));
  const horizon = addDays(today, 14);
  const load = new Map(partnerIds.map((id) => [id, planned.filter((p) => p.partnerId === id && p.date <= horizon).length]));
  const first = found.slots[0]!.date;
  const scored = found.slots.map((s) => {
    const offset = Math.round((Date.parse(s.date) - Date.parse(first)) / 86_400_000);
    const travel = (s.travelBefore ?? 0) + (s.travelAfter ?? 0);
    const l = load.get(s.partnerId) ?? 0;
    const reasons: string[] = [];
    reasons.push(offset === 0 ? "Eerste vrije moment" : `${offset} dag${offset === 1 ? "" : "en"} na het eerste vrije moment`);
    if (s.travelBefore !== null || s.travelAfter !== null) {
      reasons.push(`Rijtijd ${[s.travelBefore !== null ? `${s.travelBefore} min vanaf vorige klus` : null, s.travelAfter !== null ? `${s.travelAfter} min naar volgende` : null].filter(Boolean).join(", ")}`);
    } else reasons.push("Eerste klus van de dag voor deze monteur");
    reasons.push(l === 0 ? "Partner heeft de komende 2 weken nog niets gepland" : `Partner heeft ${l} klus${l === 1 ? "" : "sen"} in de komende 2 weken`);
    return { ...s, score: offset + l * 0.3 + travel / 30 - (s.travelBefore !== null && s.travelBefore <= 20 ? 2 : 0), reasons };
  });
  scored.sort((a, b) => a.score - b.score || a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
  return { ...found, suggestions: scored.slice(0, 3) };
}

// ---------------------------------------------------------------- Afspraken

export async function scheduleAppointment(
  db: Db,
  transport: EmailTransport | null,
  actor: ActorContext,
  projectId: string,
  input: { type: AppointmentType; date: string; technicianId: string; startMinute: number; partnerId?: string | null; notes?: string | null },
) {
  const appointment = await db.transaction(async (tx) => {
    const ctx = await projectContext(tx, projectId);
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    await assertSignedQuote(tx, projectId);
    if (input.type === "survey" && !(await journeyHasSurvey(tx, project!.statusId))) {
      throw badRequest("no_survey_in_journey", "De klantreis van dit project heeft geen schouw; plan direct de installatie");
    }
    // De monteur vergrendelen: twee planners kunnen niet tegelijk dezelfde monteur inplannen.
    const [tech] = await tx.select().from(users).where(eq(users.id, input.technicianId)).for("update");
    if (!tech || !tech.isTechnician || !tech.isActive || !tech.organizationId) throw badRequest("invalid_technician", "Onbekende monteur");
    const partnerId = tech.organizationId;
    if (input.partnerId && input.partnerId !== partnerId) throw badRequest("invalid_technician", "Deze monteur hoort niet bij deze partner");
    if (input.type === "installation" && project!.installationPartnerId && project!.installationPartnerId !== partnerId) {
      throw badRequest("partner_mismatch", "De installatie moet bij dezelfde partner als de schouw");
    }
    const [existing] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.projectId, projectId), eq(appointments.type, input.type), eq(appointments.status, "planned")));
    if (existing) throw conflict("already_planned", `Er staat al een ${TYPE_LABEL[input.type]} gepland; verzet of annuleer die eerst`);
    await assertPartnerHandlesGroup(tx, partnerId, ctx.project.productGroupId);
    // Opnieuw rekenen: past de klus nog precies op dit moment (beschikbaarheid, andere klussen, rijtijd)?
    const found = await findSlots(tx, projectId, input.type, { technicianId: input.technicianId, date: input.date });
    const slot = found.slots.find((s) => s.startMinute === input.startMinute);
    if (!slot) throw conflict("no_capacity", found.message && !found.slots.length ? found.message : "Dit moment is niet (meer) vrij voor deze monteur; kies een ander moment");
    const { minutes } = durationFor(input.type, ctx.group.installationDays);
    const [row] = await tx
      .insert(appointments)
      .values({
        projectId,
        partnerOrganizationId: partnerId,
        regionId: slot.regionId,
        type: input.type,
        date: input.date,
        days: slot.days,
        timeWindow: "day",
        technicianUserId: input.technicianId,
        startMinute: input.startMinute,
        durationMinutes: minutes,
        travelMinutes: slot.travelBefore,
        notes: input.notes ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!project!.installationPartnerId) await tx.update(projects).set({ installationPartnerId: partnerId }).where(eq(projects.id, projectId));
    await recordAudit(tx, actor, {
      action: "appointment.scheduled",
      entityType: "project",
      entityId: projectId,
      after: { type: input.type, date: input.date, start: hhmm(input.startMinute), technicianId: input.technicianId, partnerId },
    });
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
  const names = await technicianNames(db, [row.a]);
  return { ...toView(row, report ?? null), depositUnpaid: flags.has(row.a.id), technicianName: names.get(row.a.technicianUserId ?? "") ?? null };
}

/**
 * Signalering (O11): geplande schouwen (en installaties, bij een klantreis zonder schouw, B82) waarvoor de
 * aanbetaling nog niet is voldaan. Geeft de id's van de betreffende afspraken terug.
 */
async function depositFlags(db: DbOrTx, appts: (typeof appointments.$inferSelect)[]) {
  const surveys = appts.filter((a) => a.status === "planned");
  if (!surveys.length) return new Set<string>();
  const deposits = await db
    .select({ projectId: invoices.projectId, status: invoices.status })
    .from(invoices)
    .where(and(inArray(invoices.projectId, surveys.map((s) => s.projectId)), eq(invoices.type, "deposit")));
  const paid = new Set(deposits.filter((d) => d.status === "paid").map((d) => d.projectId));
  return new Set(surveys.filter((s) => !paid.has(s.projectId)).map((s) => s.id));
}

async function technicianNames(db: DbOrTx, appts: (typeof appointments.$inferSelect)[]) {
  const ids = [...new Set(appts.map((a) => a.technicianUserId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
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
    time: row.a.startMinute != null ? `${hhmm(row.a.startMinute)}–${hhmm(row.a.startMinute + (row.a.durationMinutes ?? 120))}` : null,
    arrival: arrivalText(row.a.startMinute),
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
  const names = await technicianNames(db, rows.map((r) => r.a));
  return rows.map((r) => ({
    ...toView(r, reps.find((x) => x.appointmentId === r.a.id) ?? null),
    depositUnpaid: flags.has(r.a.id),
    technicianName: names.get(r.a.technicianUserId ?? "") ?? null,
  }));
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
        SIGNED(projects.id),
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
/** Eerstvolgende geplande schouw; zonder schouw (B82) de eerstvolgende installatie. */
export async function nextSurveyDate(db: DbOrTx, projectId: string) {
  const planned = await db
    .select({ date: appointments.date, type: appointments.type })
    .from(appointments)
    .where(and(eq(appointments.projectId, projectId), eq(appointments.status, "planned")))
    .orderBy(asc(appointments.date));
  return (planned.find((a) => a.type === "survey") ?? planned.find((a) => a.type === "installation"))?.date ?? null;
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
    await tx.update(appointments).set({ status: "completed", checkedOutAt: new Date() }).where(eq(appointments.id, appointmentId));
    await recordAudit(tx, actor, { action: "report.submitted", entityType: "project", entityId: a.projectId, metadata: { appointmentId, type: a.type, positive: input.positive } });
    await emitEvent(tx, "report.submitted", { type: "report", id: r!.id }, { projectId: a.projectId, type: a.type });
    await emitJourneyEvent(tx, a.projectId, `${a.type as AppointmentType}.report_submitted`);
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
      await emitJourneyEvent(tx, a!.projectId, `${r.type as AppointmentType}.report_approved`);
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

