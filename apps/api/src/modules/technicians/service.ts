import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { roles, users } from "../auth/schema.js";
import { customers, properties } from "../customers/schema.js";
import type { EmailTransport } from "../email/transport.js";
import { sendTemplateMessage } from "../messages/service.js";
import { organizations } from "../organizations/schema.js";
import { appointments, technicianLocations } from "../planning/schema.js";
import { arrivalText, hhmm } from "../planning/time.js";
import { minutesFromLocation } from "../planning/travel.js";
import { projects } from "../projects/schema.js";
import { sendInvite } from "../users/invites.js";
import { createUser } from "../users/service.js";

/** Locaties worden 7 dagen bewaard (B87, AVG: niet langer dan nodig). */
export const LOCATION_RETENTION_DAYS = 7;

// ---------------------------------------------------------------- Beheer door de partner

export async function listTechnicians(db: DbOrTx, partnerId: string) {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, isTechnician: users.isTechnician, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.organizationId, partnerId))
    .orderBy(asc(users.name));
  const last = rows.length
    ? await db
        .select({ userId: technicianLocations.technicianUserId, at: sql<string>`max(${technicianLocations.recordedAt})` })
        .from(technicianLocations)
        .where(inArray(technicianLocations.technicianUserId, rows.map((r) => r.id)))
        .groupBy(technicianLocations.technicianUserId)
    : [];
  return rows.map((r) => ({ ...r, lastLocationAt: last.find((l) => l.userId === r.id)?.at ?? null }));
}

/** Nieuwe monteur met eigen inlog (rol Monteur); krijgt een uitnodiging om een wachtwoord in te stellen. */
export async function addTechnician(
  db: Db,
  deps: { transport: EmailTransport | null; baseUrl: string },
  actor: ActorContext,
  partnerId: string,
  input: { name: string; email: string },
) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, partnerId));
  if (!org || org.type !== "installation_partner") throw badRequest("invalid_partner", "Organisatie is geen installatiepartner");
  const [role] = await db.select().from(roles).where(eq(roles.key, "monteur"));
  if (!role) throw badRequest("no_role", "Rol 'monteur' bestaat niet");
  const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email.trim().toLowerCase()}`);
  if (taken) throw conflict("email_taken", `Er bestaat al een gebruiker met e-mailadres ${input.email}`);
  const created = await createUser(db, actor, {
    organizationId: partnerId,
    email: input.email,
    name: input.name,
    password: randomBytes(32).toString("base64url"),
    mustChangePassword: false,
    mfaRequired: true,
    roleIds: [role.id],
  });
  await db.update(users).set({ isTechnician: true }).where(eq(users.id, created.id));
  await recordAudit(db, actor, { action: "technician.added", entityType: "organization", entityId: partnerId, metadata: { userId: created.id } });
  const invite = await sendInvite(db, deps.transport, deps.baseUrl, actor, created.id);
  return { id: created.id, invite };
}

export async function updateTechnician(db: Db, actor: ActorContext, partnerId: string, userId: string, input: { isTechnician?: boolean; isActive?: boolean }) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.organizationId !== partnerId) throw notFound("Monteur");
  if (input.isActive === false && userId === actor.userId) throw badRequest("self", "U kunt uw eigen account niet uitzetten");
  if (input.isTechnician === false || input.isActive === false) {
    const [busy] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.technicianUserId, userId), eq(appointments.status, "planned"), gte(appointments.date, todayIso())))
      .limit(1);
    if (busy) throw conflict("has_jobs", "Deze monteur heeft nog geplande klussen; laat die eerst verzetten");
  }
  await db.update(users).set(input).where(eq(users.id, userId));
  await recordAudit(db, actor, { action: "technician.updated", entityType: "user", entityId: userId, after: input });
  return listTechnicians(db, partnerId);
}

// ---------------------------------------------------------------- Monteursportaal

/** Klussen van de monteur op een dag, op volgorde, met adres en klantgegevens die hij nodig heeft. */
export async function technicianDay(db: DbOrTx, technicianId: string, date: string) {
  const rows = await db
    .select({ a: appointments, property: properties, customer: customers, number: projects.number })
    .from(appointments)
    .innerJoin(projects, eq(projects.id, appointments.projectId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .where(
      and(
        eq(appointments.technicianUserId, technicianId),
        inArray(appointments.status, ["planned", "completed"]),
        lt(appointments.date, sql`${date}::date + 1`),
        gte(sql`${appointments.date} + (${appointments.days} - 1)`, date),
      ),
    )
    .orderBy(asc(appointments.startMinute));
  return rows.map((r) => {
    const p = r.property;
    const start = r.a.startMinute ?? 480;
    const end = start + (r.a.durationMinutes ?? 120);
    return {
      id: r.a.id,
      type: r.a.type,
      status: r.a.status,
      date: r.a.date,
      days: r.a.days,
      time: `${hhmm(start)}–${hhmm(end)}`,
      startMinute: start,
      projectNumber: `P-${String(r.number).padStart(6, "0")}`,
      address: `${p.street} ${p.houseNumber}${p.houseNumberAddition ? `-${p.houseNumberAddition}` : ""}, ${p.postalCode} ${p.city}`,
      postalCode: p.postalCode,
      customerName: [r.customer.firstName, r.customer.lastName].filter(Boolean).join(" "),
      customerPhone: r.customer.phone,
      travelMinutes: r.a.travelMinutes,
      enRouteAt: r.a.enRouteAt,
      etaAt: r.a.etaAt,
      checkedInAt: r.a.checkedInAt,
      checkedOutAt: r.a.checkedOutAt,
    };
  });
}

async function ownJob(db: DbOrTx, technicianId: string, appointmentId: string) {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
  if (!a || a.technicianUserId !== technicianId) throw notFound("Klus");
  if (a.status !== "planned") throw conflict("not_planned", "Deze klus is al afgerond of geannuleerd");
  return a;
}

/** Locatie tijdens de werkdag (B87). Alleen tussen 06:00 en 20:00; ouder dan 7 dagen wordt verwijderd. */
export async function recordLocation(db: DbOrTx, technicianId: string, input: { lat: number; lng: number; accuracy?: number | null }) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false }).format(new Date()));
  if (hour < 6 || hour >= 20) return { stored: false };
  await db.insert(technicianLocations).values({ technicianUserId: technicianId, lat: input.lat, lng: input.lng, accuracy: input.accuracy ?? null });
  return { stored: true };
}

export async function purgeLocations(db: DbOrTx) {
  await db.delete(technicianLocations).where(lt(technicianLocations.recordedAt, new Date(Date.now() - LOCATION_RETENTION_DAYS * 86_400_000)));
}

const clock = (d: Date) => new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(d);

/**
 * Monteur vertrekt naar de klant: rijtijd vanaf zijn huidige locatie (Google Maps) → verwachte aankomst.
 * De klant krijgt een bericht (e-mail en WhatsApp) met de aankomsttijd.
 */
export async function enRoute(db: Db, transport: EmailTransport | null, actor: ActorContext, appointmentId: string, loc: { lat: number; lng: number } | null) {
  const a = await ownJob(db, actor.userId!, appointmentId);
  const [row] = await db
    .select({ property: properties, customer: customers, techName: users.name })
    .from(projects)
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .innerJoin(users, eq(users.id, actor.userId!))
    .where(eq(projects.id, a.projectId));
  if (loc) await recordLocation(db, actor.userId!, loc);
  const minutes = loc ? await minutesFromLocation(loc.lat, loc.lng, row!.property.postalCode) : null;
  const now = new Date();
  const eta = minutes !== null ? new Date(now.getTime() + minutes * 60_000) : null;
  await db.update(appointments).set({ enRouteAt: now, etaAt: eta }).where(eq(appointments.id, a.id));
  await recordAudit(db, actor, { action: "appointment.en_route", entityType: "project", entityId: a.projectId, metadata: { appointmentId: a.id, etaMinutes: minutes } });
  const first = row!.techName.trim().split(/\s+/)[0] ?? row!.techName;
  await sendTemplateMessage(db, transport, { key: "appointment.en_route" }, {
    to: row!.customer.email,
    customerId: row!.customer.id,
    related: { type: "appointment", id: a.id },
    vars: {
      naam: [row!.customer.firstName, row!.customer.lastName].filter(Boolean).join(" "),
      voornaam: row!.customer.firstName || row!.customer.lastName,
      monteur: first,
      aankomst: eta ? `rond ${clock(eta)} uur` : arrivalText(a.startMinute) ?? "vandaag",
    },
    dedupeKey: `appointment.en_route:${a.id}:${todayIso()}`,
  });
  return { etaAt: eta, minutes };
}

/** Aanmelden: monteur is op locatie en begint. */
export async function checkIn(db: Db, actor: ActorContext, appointmentId: string, loc: { lat: number; lng: number } | null) {
  const a = await ownJob(db, actor.userId!, appointmentId);
  if (loc) await recordLocation(db, actor.userId!, loc);
  await db.update(appointments).set({ checkedInAt: new Date() }).where(eq(appointments.id, a.id));
  await recordAudit(db, actor, { action: "appointment.checked_in", entityType: "project", entityId: a.projectId, metadata: { appointmentId: a.id } });
  return { ok: true };
}

/** Afmelden gebeurt met het opleverrapport (submitReport); dit legt alleen het tijdstip vast. */
export async function markCheckedOut(db: DbOrTx, appointmentId: string) {
  await db.update(appointments).set({ checkedOutAt: new Date() }).where(eq(appointments.id, appointmentId));
}

/** Laatst bekende locatie per monteur van een partner (voor planner of partner). */
export async function lastLocations(db: DbOrTx, technicianIds: string[]) {
  if (!technicianIds.length) return [];
  const rows = await db.execute<{ technician_user_id: string; lat: number; lng: number; recorded_at: Date }>(sql`
    select distinct on (technician_user_id) technician_user_id, lat, lng, recorded_at
    from technician_locations
    where technician_user_id in (${sql.join(technicianIds.map((id) => sql`${id}`), sql`, `)})
      and recorded_at > now() - interval '12 hours'
    order by technician_user_id, recorded_at desc`);
  return rows.rows.map((r) => ({ technicianId: r.technician_user_id, lat: Number(r.lat), lng: Number(r.lng), recordedAt: new Date(r.recorded_at).toISOString() }));
}

