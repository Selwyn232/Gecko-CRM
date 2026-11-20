import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { escapeHtml, layout, type Company } from "../email/layout.js";
import { outboundEmails } from "../email/schema.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { journeyStatuses } from "../journeys/schema.js";
import { organizations } from "../organizations/schema.js";
import { appointments } from "../planning/schema.js";
import { projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { getCompany } from "../quotes/links.js";
import { messageTemplates } from "./schema.js";
import {
  DEFAULT_STATUS_MESSAGES,
  FIXED_KEYS,
  FIXED_MESSAGES,
  fill,
  SAMPLE_VARS,
  unknownPlaceholders,
  type FixedMessageKey,
  type MessageVars,
} from "./templates.js";

export type TemplateTarget = { key: FixedMessageKey } | { journeyStatusId: string };

const TYPE_LABEL = { survey: "schouw", installation: "installatie" } as const;
const WINDOW_LABEL = { morning: "in de ochtend (8:00–12:00)", afternoon: "in de middag (12:00–17:00)", day: "gedurende de dag" } as const;
const dateNl = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Platte tekst met invulvelden → e-mail in de huisstijl. Een lege regel = nieuwe alinea. */
export function renderMessage(company: Company, tpl: { subject: string; body: string }, vars: MessageVars) {
  const subject = fill(tpl.subject, vars).replace(/\s+/g, " ").trim();
  const text = fill(tpl.body, vars).trim();
  const html = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return { subject, text, html: layout(company, html) };
}

const where = (t: TemplateTarget) =>
  "key" in t ? and(eq(messageTemplates.key, t.key), eq(messageTemplates.channel, "email")) : and(eq(messageTemplates.journeyStatusId, t.journeyStatusId), eq(messageTemplates.channel, "email"));

/** Het geldende sjabloon. Vaste momenten zonder eigen rij gebruiken de standaardtekst (actief). */
export async function getTemplate(db: DbOrTx, target: TemplateTarget) {
  const [row] = await db.select().from(messageTemplates).where(where(target));
  if (row) return { subject: row.subject, body: row.body, isActive: row.isActive };
  if ("key" in target) return { ...FIXED_MESSAGES[target.key], isActive: true };
  return null;
}

/**
 * Verstuurt het bericht als het sjabloon bestaat en actief is en de klant een e-mailadres heeft.
 * Geeft null als er niets is verstuurd (ook als dit bericht met dezelfde dedupeKey al eerder is verstuurd).
 */
export async function sendTemplateMessage(
  db: DbOrTx,
  transport: EmailTransport | null,
  target: TemplateTarget,
  input: { to: string | null; customerId: string; related: { type: string; id: string }; vars: MessageVars; dedupeKey?: string },
) {
  if (!input.to) return null;
  if (input.dedupeKey) {
    const [done] = await db.select({ id: outboundEmails.id }).from(outboundEmails).where(eq(outboundEmails.dedupeKey, input.dedupeKey));
    if (done) return null;
  }
  const tpl = await getTemplate(db, target);
  if (!tpl?.isActive) return null;
  const company = await getCompany(db);
  const msg = renderMessage(company, tpl, { bedrijf: company.name, ...input.vars });
  return sendEmail(db, transport, {
    to: input.to,
    ...msg,
    template: "key" in target ? target.key : "project.status",
    customerId: input.customerId,
    related: input.related,
    dedupeKey: input.dedupeKey,
  });
}

/** Invulvelden voor een afspraak (structureel getypt, zodat planning dit kan gebruiken zonder kringverwijzing). */
export function appointmentVars(a: {
  type: string;
  date: string;
  days: number;
  timeWindow: string;
  address: string;
  partnerName: string;
  productGroupName: string;
  projectNumber: string;
  customer: { firstName: string | null; lastName: string };
}): MessageVars {
  return {
    ...customerVars(a.customer),
    projectnummer: a.projectNumber,
    productgroep: a.productGroupName.toLowerCase(),
    adres: a.address,
    afspraak_soort: TYPE_LABEL[a.type as keyof typeof TYPE_LABEL] ?? a.type,
    afspraak_datum: dateNl(a.date),
    dagdeel: WINDOW_LABEL[a.timeWindow as keyof typeof WINDOW_LABEL] ?? "",
    aantal_dagen: String(a.days),
    partner: a.partnerName,
  };
}

const customerVars = (c: { firstName: string | null; lastName: string }): MessageVars => ({
  voornaam: c.firstName || c.lastName,
  achternaam: c.lastName,
  naam: [c.firstName, c.lastName].filter(Boolean).join(" "),
});

/** Invulvelden voor een project, inclusief de eerstvolgende geplande afspraak (als die er is). */
export async function projectVars(db: DbOrTx, projectId: string) {
  const [row] = await db
    .select({ project: projects, customer: customers, property: properties, groupName: productGroups.name, statusName: journeyStatuses.name })
    .from(projects)
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .innerJoin(properties, eq(properties.id, projects.propertyId))
    .innerJoin(productGroups, eq(productGroups.id, projects.productGroupId))
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(eq(projects.id, projectId));
  if (!row) return null;
  const p = row.property;
  const vars: MessageVars = {
    ...customerVars(row.customer),
    projectnummer: formatProjectNumber(row.project.number),
    productgroep: row.groupName.toLowerCase(),
    adres: `${p.street} ${p.houseNumber}${p.houseNumberAddition ? `-${p.houseNumberAddition}` : ""}, ${p.postalCode} ${p.city}`,
    status: row.statusName,
  };
  const [next] = await db
    .select({ a: appointments, partnerName: organizations.name })
    .from(appointments)
    .innerJoin(organizations, eq(organizations.id, appointments.partnerOrganizationId))
    .where(and(eq(appointments.projectId, projectId), eq(appointments.status, "planned"), gte(appointments.date, todayIso())))
    .orderBy(asc(appointments.date))
    .limit(1);
  if (next) {
    Object.assign(vars, {
      afspraak_soort: TYPE_LABEL[next.a.type],
      afspraak_datum: dateNl(next.a.date),
      dagdeel: WINDOW_LABEL[next.a.timeWindow as keyof typeof WINDOW_LABEL] ?? "",
      aantal_dagen: String(next.a.days),
      partner: next.partnerName,
    });
  }
  return { vars, customer: row.customer };
}

/** Bericht bij het bereiken van een status. `dedupeKey` voorkomt dubbel versturen bij een herhaalde verwerking. */
export async function sendStatusMessage(db: DbOrTx, transport: EmailTransport | null, projectId: string, statusId: string, dedupeKey: string) {
  const ctx = await projectVars(db, projectId);
  if (!ctx) return null;
  const [status] = await db.select({ name: journeyStatuses.name }).from(journeyStatuses).where(eq(journeyStatuses.id, statusId));
  return sendTemplateMessage(db, transport, { journeyStatusId: statusId }, {
    to: ctx.customer.email,
    customerId: ctx.customer.id,
    related: { type: "project", id: projectId },
    vars: { ...ctx.vars, status: status?.name ?? ctx.vars.status },
    dedupeKey,
  });
}

// ---------------------------------------------------------------- Beheer

/** Overzicht voor het beheerscherm: vaste momenten en per productgroep de statussen. */
export async function listTemplates(db: DbOrTx) {
  const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.channel, "email"));
  const fixed = FIXED_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    const def = FIXED_MESSAGES[key];
    return { key, label: def.label, when: def.when, defaultSubject: def.subject, defaultBody: def.body, subject: row?.subject ?? def.subject, body: row?.body ?? def.body, isActive: row?.isActive ?? true, isDefault: !row || (row.subject === def.subject && row.body === def.body) };
  });
  const groups = await db.select().from(productGroups).where(eq(productGroups.isActive, true)).orderBy(asc(productGroups.sortOrder), asc(productGroups.name));
  const statuses = groups.length
    ? await db.select().from(journeyStatuses).where(inArray(journeyStatuses.productGroupId, groups.map((g) => g.id))).orderBy(asc(journeyStatuses.sortOrder))
    : [];
  // Eén tabblad per klantreis: de standaard per productgroep, plus eigen klantreizen van verkoopkanalen (B80).
  const channels = await db.select({ id: salesChannels.id, name: salesChannels.name }).from(salesChannels);
  const journeys = groups.flatMap((g) => {
    const own = [...new Set(statuses.filter((s) => s.productGroupId === g.id && s.salesChannelId).map((s) => s.salesChannelId!))];
    return [
      { g, channel: null as { id: string; name: string } | null },
      ...own.map((id) => ({ g, channel: channels.find((c) => c.id === id) ?? { id, name: "?" } })),
    ];
  });
  return {
    fixed,
    groups: journeys.map(({ g, channel }) => ({
      key: channel ? `${g.id}:${channel.id}` : g.id,
      label: channel ? `${g.name} · ${channel.name}` : g.name,
      productGroup: { id: g.id, name: g.name },
      salesChannel: channel,
      statuses: statuses
        .filter((s) => s.productGroupId === g.id && (s.salesChannelId ?? null) === (channel?.id ?? null))
        .map((s) => {
          const row = rows.find((r) => r.journeyStatusId === s.id);
          return {
            journeyStatusId: s.id,
            statusKey: s.key,
            name: s.name,
            phase: s.phase,
            color: s.color,
            statusActive: s.isActive,
            template: row ? { subject: row.subject, body: row.body, isActive: row.isActive } : null,
          };
        }),
    })),
  };
}

export async function saveTemplate(db: DbOrTx, actor: ActorContext, target: TemplateTarget, input: { subject: string; body: string; isActive: boolean }) {
  const unknown = unknownPlaceholders(`${input.subject}\n${input.body}`);
  if (unknown.length) throw badRequest("unknown_placeholder", `Onbekend invulveld: ${unknown.map((u) => `{${u}}`).join(", ")}`);
  if ("journeyStatusId" in target) {
    const [s] = await db.select({ id: journeyStatuses.id }).from(journeyStatuses).where(eq(journeyStatuses.id, target.journeyStatusId));
    if (!s) throw notFound("Status");
  }
  const [before] = await db.select().from(messageTemplates).where(where(target));
  const values = { subject: input.subject.trim(), body: input.body.trim(), isActive: input.isActive };
  const [row] = before
    ? await db.update(messageTemplates).set(values).where(eq(messageTemplates.id, before.id)).returning()
    : await db.insert(messageTemplates).values({ ...values, ...("key" in target ? { key: target.key } : { journeyStatusId: target.journeyStatusId }) }).returning();
  await recordAudit(db, actor, {
    action: "message_template.updated",
    entityType: "message_template",
    entityId: row!.id,
    before: before ? { subject: before.subject, body: before.body, isActive: before.isActive } : undefined,
    after: values,
  });
  return row!;
}

/** Voorvertoning met voorbeeldgegevens. */
export async function previewMessage(db: DbOrTx, input: { subject: string; body: string }) {
  const company = await getCompany(db);
  return { ...renderMessage(company, input, { ...SAMPLE_VARS, bedrijf: company.name }), unknownPlaceholders: unknownPlaceholders(`${input.subject}\n${input.body}`) };
}

/** Testmail met voorbeeldgegevens naar een opgegeven adres (meestal de eigen gebruiker). */
export async function sendTestMessage(db: DbOrTx, transport: EmailTransport | null, to: string, input: { subject: string; body: string }) {
  const company = await getCompany(db);
  const msg = renderMessage(company, input, { ...SAMPLE_VARS, bedrijf: company.name });
  return sendEmail(db, transport, { to, ...msg, subject: `[TEST] ${msg.subject}`, template: "message.test" });
}

/**
 * Standaardberichten aanmaken waar nog niets is ingesteld. Bestaande (aangepaste of uitgezette)
 * berichten worden nooit overschreven.
 */
export async function ensureDefaultMessageTemplates(db: DbOrTx) {
  const existing = await db.select({ key: messageTemplates.key, statusId: messageTemplates.journeyStatusId }).from(messageTemplates);
  for (const key of FIXED_KEYS) {
    if (!existing.some((e) => e.key === key)) await db.insert(messageTemplates).values({ key, subject: FIXED_MESSAGES[key].subject, body: FIXED_MESSAGES[key].body });
  }
  const statuses = await db.select().from(journeyStatuses).where(inArray(journeyStatuses.key, Object.keys(DEFAULT_STATUS_MESSAGES)));
  for (const s of statuses) {
    if (existing.some((e) => e.statusId === s.id)) continue;
    const def = DEFAULT_STATUS_MESSAGES[s.key]!;
    await db.insert(messageTemplates).values({ journeyStatusId: s.id, subject: def.subject, body: def.body, isActive: def.isActive });
  }
}
