import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Config } from "../../config.js";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { auditLog } from "../audit/schema.js";
import { recordAudit } from "../audit/service.js";
import { roles, userRoles, users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { button, escapeHtml, layout } from "../email/layout.js";
import { brandName, sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { journeyStatuses } from "../journeys/schema.js";
import { projects } from "../projects/schema.js";
import { getCompany } from "../quotes/links.js";
import { notifyPermission } from "../tasks/service.js";

/**
 * Klantspecialisten (B81). Elke klant krijgt bij de getekende order een vaste klantspecialist, die tot en met
 * de afgeronde installatie het aanspreekpunt is. Daarna gaat de klant naar de afdeling Service.
 * Een klantspecialist (zonder recht customers.all) ziet alleen de eigen klanten.
 */
export const SPECIALIST_ROLE_KEY = "klantspecialist";
/** Boven deze bezetting krijgt de manager een signaal om op tijd extra specialisten aan te nemen. */
export const CAPACITY_WARNING = 0.85;

// ---------------------------------------------------------------- Zichtbaarheid

/** Ziet deze gebruiker alleen de eigen klanten? Geeft dan het gebruikers-id, anders null (alles zien). */
export function ownCustomersOnly(actor: ActorContext): string | null {
  if (!actor.userId || actor.permissions.has("customers.all")) return null;
  return actor.permissions.has("customers.read") ? actor.userId : null;
}

/** Filter "alleen eigen klanten" op een kolom met een klant-id (of null als alles zichtbaar is). */
export function ownCustomerFilter(actor: ActorContext, customerIdColumn: AnyPgColumn): SQL | null {
  const own = ownCustomersOnly(actor);
  if (!own) return null;
  return sql`${customerIdColumn} IN (SELECT ${customers.id} FROM ${customers} WHERE ${customers.specialistUserId} = ${own})`;
}

/** Klant niet van deze specialist: zelfde antwoord als "bestaat niet", zodat niets uitlekt. */
export async function assertCustomerVisible(db: DbOrTx, actor: ActorContext, customerId: string | null | undefined, what = "Klant") {
  const own = ownCustomersOnly(actor);
  if (!own) return;
  if (!customerId) throw notFound(what);
  const [c] = await db.select({ s: customers.specialistUserId }).from(customers).where(eq(customers.id, customerId));
  if (!c || c.s !== own) throw notFound(what);
}

// ---------------------------------------------------------------- Bezetting

/** Lopende klanten = klanten met deze specialist (die na de installatie gaan naar Service en tellen dan niet meer). */
async function loadByUser(db: DbOrTx) {
  const rows = await db
    .select({ userId: customers.specialistUserId, n: count() })
    .from(customers)
    .where(isNotNull(customers.specialistUserId))
    .groupBy(customers.specialistUserId);
  return new Map(rows.map((r) => [r.userId!, Number(r.n)]));
}

async function specialistUsers(db: DbOrTx) {
  return db
    .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive, maxCustomers: users.maxCustomers, acceptsNewCustomers: users.acceptsNewCustomers, hasPhoto: sql<boolean>`${users.photoDataUrl} IS NOT NULL`, createdAt: users.createdAt })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.key, SPECIALIST_ROLE_KEY))
    .orderBy(asc(users.name));
}

/** De specialist met de minste lopende klanten die nog plek heeft en nieuwe klanten aanneemt. */
export async function pickSpecialist(db: DbOrTx, preferUserId?: string | null) {
  const list = (await specialistUsers(db)).filter((u) => u.isActive && u.acceptsNewCustomers);
  const load = await loadByUser(db);
  const free = list.filter((u) => u.maxCustomers == null || (load.get(u.id) ?? 0) < u.maxCustomers);
  if (preferUserId && free.some((u) => u.id === preferUserId)) return free.find((u) => u.id === preferUserId)!;
  free.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
  return free[0] ?? null;
}

/** Overzicht voor de manager klantenservice. */
export async function specialistOverview(db: DbOrTx) {
  const list = await specialistUsers(db);
  const load = await loadByUser(db);
  const unassigned = await db
    .select({ n: count() })
    .from(customers)
    .where(
      and(
        isNull(customers.specialistUserId),
        isNull(customers.serviceSince),
        sql`EXISTS (SELECT 1 FROM ${projects} p JOIN ${journeyStatuses} s ON s.id = p.status_id WHERE p.customer_id = ${customers.id} AND NOT s.is_final)`,
      ),
    );
  const rows = list.map((u) => {
    const n = load.get(u.id) ?? 0;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      isActive: u.isActive,
      hasPhoto: u.hasPhoto,
      acceptsNewCustomers: u.acceptsNewCustomers,
      maxCustomers: u.maxCustomers,
      customers: n,
      utilization: u.maxCustomers ? n / u.maxCustomers : null,
    };
  });
  const capped = rows.filter((r) => r.isActive && r.maxCustomers);
  const capacity = capped.reduce((s, r) => s + r.maxCustomers!, 0);
  const used = capped.reduce((s, r) => s + r.customers, 0);
  return {
    specialists: rows,
    totals: {
      customers: rows.reduce((s, r) => s + r.customers, 0),
      capacity: capacity || null,
      utilization: capacity ? used / capacity : null,
      warning: capacity ? used / capacity >= CAPACITY_WARNING : false,
      unassigned: Number(unassigned[0]?.n ?? 0),
      withoutLimit: rows.filter((r) => r.isActive && r.maxCustomers == null).length,
    },
    warningAt: CAPACITY_WARNING,
  };
}

export async function updateSpecialist(db: Db, actor: ActorContext, userId: string, input: { maxCustomers?: number | null; acceptsNewCustomers?: boolean; photoDataUrl?: string | null }) {
  if (!(await specialistUsers(db)).some((u) => u.id === userId)) throw notFound("Klantspecialist");
  if (input.photoDataUrl && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.photoDataUrl)) {
    throw badRequest("invalid_photo", "Foto moet een PNG-, JPEG- of WebP-afbeelding zijn");
  }
  const [before] = await db.select({ maxCustomers: users.maxCustomers, acceptsNewCustomers: users.acceptsNewCustomers }).from(users).where(eq(users.id, userId));
  await db.update(users).set(input).where(eq(users.id, userId));
  const { photoDataUrl, ...rest } = input;
  await recordAudit(db, actor, {
    action: "specialist.updated",
    entityType: "user",
    entityId: userId,
    before,
    after: { ...rest, ...(photoDataUrl !== undefined ? { photo: photoDataUrl ? "nieuw" : "verwijderd" } : {}) },
  });
  return (await specialistOverview(db)).specialists.find((s) => s.id === userId);
}

/** Pasfoto voor e-mails (publiek op id; bevat geen andere gegevens). */
export async function specialistPhoto(db: DbOrTx, userId: string) {
  const [u] = await db.select({ photo: users.photoDataUrl }).from(users).where(eq(users.id, userId));
  const m = u?.photo?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) throw notFound("Foto");
  return { contentType: m[1]!, body: Buffer.from(m[2]!, "base64") };
}

// ---------------------------------------------------------------- Koppelen, overzetten, naar Service

export interface SpecialistDeps {
  emailTransport: EmailTransport | null;
  config: Pick<Config, "APP_BASE_URL">;
}

async function messageCustomer(db: Db, deps: SpecialistDeps, customerId: string, specialistId: string, kind: "welcome" | "transfer", dedupeKey: string) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  const [s] = await db.select({ id: users.id, name: users.name, photo: users.photoDataUrl }).from(users).where(eq(users.id, specialistId));
  if (!c?.email || !s) return null;
  const company = await getCompany(db);
  const base = deps.config.APP_BASE_URL.replace(/\/$/, "");
  const first = s.name.split(" ")[0];
  const photo = s.photo
    ? `<p style="margin:16px 0"><img src="${base}/api/public/specialists/${s.id}/photo" width="72" height="72" alt="${escapeHtml(s.name)}" style="border-radius:50%;object-fit:cover;vertical-align:middle"> <strong style="font-size:16px;margin-left:12px">${escapeHtml(s.name)}</strong></p>`
    : `<p style="margin:16px 0"><strong style="font-size:16px">${escapeHtml(s.name)}</strong></p>`;
  const greeting = `Beste ${escapeHtml(c.firstName ?? c.lastName)},`;
  const intro =
    kind === "welcome"
      ? `<p>Welkom bij ${escapeHtml(company.name)}! Vanaf nu heeft u één vaste contactpersoon die alles voor u regelt, van de planning tot en met de installatie:</p>`
      : `<p>Vanaf nu helpt een nieuwe klantspecialist u verder. Uw dossier is volledig overgedragen; u hoeft niets opnieuw uit te leggen. Uw nieuwe contactpersoon:</p>`;
  const html = `<p>${greeting}</p>${intro}${photo}<p>Heeft u een vraag? Beantwoord gewoon deze e-mail; ${escapeHtml(first ?? s.name)} leest mee en reageert binnen 24 uur, bij spoed binnen 1 uur. Liever teruggebeld? Laat het weten met een tijdvak van 2 uur dat u uitkomt.</p>
${button(`${base}/mijn`, "Naar Mijn Gecko")}
<p>Met vriendelijke groet,<br>${escapeHtml(s.name)}<br>Klantspecialist, ${escapeHtml(company.name)}</p>`;
  const subject = kind === "welcome" ? `Uw vaste contactpersoon bij ${company.name}: ${s.name}` : `Uw nieuwe contactpersoon bij ${company.name}: ${s.name}`;
  return sendEmail(db, deps.emailTransport, {
    to: c.email,
    subject,
    html: layout(company, html),
    text: `${html.replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim()}\n\nMijn Gecko: ${base}/mijn`,
    template: kind === "welcome" ? "specialist.welcome" : "specialist.transfer",
    fromName: `${s.name.trim().split(/\s+/)[0]} | ${brandName(company.name)}`,
    customerId,
    dedupeKey,
    whatsapp: {
      template: kind === "welcome" ? "welkom" : "nieuweContactpersoon",
      params: [c.firstName ?? c.lastName, s.name],
      headerImageUrl: s.photo ? `${base}/api/public/specialists/${s.id}/photo` : null,
    },
  });
}

/**
 * Bij een getekende order: klant zonder specialist krijgt er automatisch een (de minst bezette met plek; bij een
 * terugkerende klant bij voorkeur de vorige). Geen plek = melding aan de manager; de klant blijft dan ongekoppeld.
 */
export async function assignOnSignedOrder(db: Db, deps: SpecialistDeps, customerId: string, eventId: number) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c || c.specialistUserId) return null;
  // Terugkerende klant: bij voorkeur de vorige specialist (uit het logboek).
  const [last] = await db
    .select({ userId: sql<string | null>`${auditLog.metadata}->>'to'` })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "customer"), eq(auditLog.entityId, customerId), inArray(auditLog.action, ["customer.specialist_assigned", "customer.specialist_transferred"])))
    .orderBy(desc(auditLog.id))
    .limit(1);
  const pick = await pickSpecialist(db, last?.userId);
  if (!pick) {
    await notifyPermission(db, "specialists.manage", {
      title: "Nieuwe klant zonder klantspecialist",
      body: "Alle klantspecialisten zitten vol of nemen geen nieuwe klanten aan. Koppel handmatig of verhoog het maximum.",
      href: `/klanten/${customerId}`,
      dedupeKey: `specialist-none:${eventId}`,
    });
    return null;
  }
  await db.update(customers).set({ specialistUserId: pick.id, specialistAssignedAt: new Date(), serviceSince: null }).where(eq(customers.id, customerId));
  await recordAudit(db, { userId: null, organizationId: null, permissions: new Set() }, {
    action: "customer.specialist_assigned",
    entityType: "customer",
    entityId: customerId,
    metadata: { to: pick.id, auto: true },
  });
  await messageCustomer(db, deps, customerId, pick.id, "welcome", `specialist-welcome:${customerId}:${pick.id}`);
  return pick;
}

/**
 * Klanten overzetten naar een andere specialist (afwezigheid, vertrek, herverdeling). Elke klant krijgt een bericht
 * met de nieuwe contactpersoon. `customerIds` leeg = alle lopende klanten van `fromUserId`.
 */
export async function transferCustomers(
  db: Db,
  deps: SpecialistDeps,
  actor: ActorContext,
  input: { fromUserId?: string | null; customerIds?: string[]; toUserId: string; notify?: boolean },
) {
  const target = (await specialistUsers(db)).find((u) => u.id === input.toUserId && u.isActive);
  if (!target) throw badRequest("invalid_specialist", "Kies een actieve klantspecialist");
  let ids = input.customerIds ?? [];
  if (!ids.length) {
    if (!input.fromUserId) throw badRequest("nothing_selected", "Kies klanten of een specialist om van over te zetten");
    ids = (await db.select({ id: customers.id }).from(customers).where(eq(customers.specialistUserId, input.fromUserId))).map((r) => r.id);
  }
  if (!ids.length) return { moved: 0 };
  const rows = await db
    .select({ id: customers.id, from: customers.specialistUserId })
    .from(customers)
    .where(and(inArray(customers.id, ids), sql`${customers.specialistUserId} IS DISTINCT FROM ${input.toUserId}`));
  if (!rows.length) return { moved: 0 };
  const now = new Date();
  await db.update(customers).set({ specialistUserId: input.toUserId, specialistAssignedAt: now, serviceSince: null }).where(inArray(customers.id, rows.map((r) => r.id)));
  for (const r of rows) {
    await recordAudit(db, actor, { action: r.from ? "customer.specialist_transferred" : "customer.specialist_assigned", entityType: "customer", entityId: r.id, metadata: { from: r.from, to: input.toUserId } });
    if (input.notify !== false) {
      await messageCustomer(db, deps, r.id, input.toUserId, r.from ? "transfer" : "welcome", `specialist-${r.from ? "transfer" : "welcome"}:${r.id}:${input.toUserId}:${now.getTime()}`);
    }
  }
  return { moved: rows.length };
}

/**
 * Na een eindstatus: heeft de klant geen lopend project meer, dan stopt de koppeling. Is er een project afgerond
 * (niet geannuleerd), dan gaat de klant naar de afdeling Service.
 */
export async function releaseIfDone(db: Db, projectId: string) {
  const [p] = await db.select({ customerId: projects.customerId }).from(projects).where(eq(projects.id, projectId));
  if (!p) return;
  const [c] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  if (!c?.specialistUserId) return;
  const states = await db
    .select({ isFinal: journeyStatuses.isFinal, key: journeyStatuses.key })
    .from(projects)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(eq(projects.customerId, c.id));
  if (states.some((s) => !s.isFinal)) return;
  const completed = states.some((s) => s.key !== "geannuleerd");
  await db.update(customers).set({ specialistUserId: null, serviceSince: completed ? new Date() : c.serviceSince }).where(eq(customers.id, c.id));
  await recordAudit(db, { userId: null, organizationId: null, permissions: new Set() }, {
    action: completed ? "customer.to_service" : "customer.specialist_released",
    entityType: "customer",
    entityId: c.id,
    metadata: { from: c.specialistUserId },
  });
}

/** Handmatig koppelen of ontkoppelen door de manager (zonder bericht als `notify` false is). */
export async function setCustomerSpecialist(db: Db, deps: SpecialistDeps, actor: ActorContext, customerId: string, userId: string | null, notify = true) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Klant");
  if (userId) return transferCustomers(db, deps, actor, { customerIds: [customerId], toUserId: userId, notify });
  await db.update(customers).set({ specialistUserId: null }).where(eq(customers.id, customerId));
  await recordAudit(db, actor, { action: "customer.specialist_released", entityType: "customer", entityId: customerId, metadata: { from: c.specialistUserId } });
  return { moved: 0 };
}

/** Klanten van één specialist (voor het overzetscherm van de manager). */
export async function customersOf(db: DbOrTx, userId: string) {
  return db
    .select({ id: customers.id, number: customers.number, firstName: customers.firstName, lastName: customers.lastName, assignedAt: customers.specialistAssignedAt })
    .from(customers)
    .where(eq(customers.specialistUserId, userId))
    .orderBy(asc(customers.lastName));
}

/** Lijst met projecten inperken tot de eigen klanten (voor lijsten die zelf niet filteren, zoals de planning). */
export async function keepOwnProjects<T extends { projectId: string }>(db: DbOrTx, actor: ActorContext, list: T[]): Promise<T[]> {
  const own = ownCustomersOnly(actor);
  if (!own) return list;
  const ids = new Set(
    (await db.select({ id: projects.id }).from(projects).innerJoin(customers, eq(customers.id, projects.customerId)).where(eq(customers.specialistUserId, own))).map((r) => r.id),
  );
  return list.filter((x) => ids.has(x.projectId));
}
