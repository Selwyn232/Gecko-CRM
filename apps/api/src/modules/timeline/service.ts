import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { users } from "../auth/schema.js";
import { customers, properties } from "../customers/schema.js";
import { formatCustomerNumber } from "../customers/service.js";
import { outboundEmails } from "../email/schema.js";
import { invoices, payments } from "../invoices/schema.js";
import { journeyStatuses } from "../journeys/schema.js";
import { organizations } from "../organizations/schema.js";
import { appointments } from "../planning/schema.js";
import { projectStatusHistory, projects } from "../projects/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { quotes } from "../quotes/schema.js";
import { formatQuoteNumber } from "../quotes/service.js";
import { customerNotes } from "./schema.js";
import { inboundEmails } from "../inbox/schema.js";

export interface TimelineEntry {
  at: string;
  kind: "note" | "call" | "email" | "status" | "appointment" | "quote" | "invoice" | "payment";
  title: string;
  detail?: string | null;
  by?: string | null;
  projectNumber?: string | null;
  href?: string | null;
}

const iso = (d: Date | string | null) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

/**
 * Alles rond een klant in één tijdlijn, nieuwste eerst: notities, e-mails, statuswissels, afspraken, offertes,
 * facturen en betalingen. Onderdelen alleen met het bijbehorende recht.
 */
export async function customerTimeline(db: DbOrTx, actor: ActorContext, customerId: string, limit = 200) {
  const can = (p: string) => actor.permissions.has(p as never);
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Klant");
  const projectRows = await db.select({ id: projects.id, number: projects.number }).from(projects).where(eq(projects.customerId, customerId));
  const projectIds = projectRows.map((p) => p.id);
  const pn = (id: string | null) => (id ? formatProjectNumber(projectRows.find((p) => p.id === id)?.number ?? 0) : null);
  const out: TimelineEntry[] = [];

  const notes = await db
    .select({ n: customerNotes, by: users.name })
    .from(customerNotes)
    .leftJoin(users, eq(users.id, customerNotes.createdBy))
    .where(eq(customerNotes.customerId, customerId));
  for (const { n, by } of notes) out.push({ at: iso(n.createdAt)!, kind: n.kind === "call" ? "call" : "note", title: n.kind === "call" ? "Telefoongesprek" : "Notitie", detail: n.body, by, projectNumber: pn(n.projectId) });

  const inbound = await db.select().from(inboundEmails).where(eq(inboundEmails.customerId, customerId));
  for (const m of inbound) out.push({ at: iso(m.receivedAt)!, kind: "email", title: `E-mail van klant: ${m.subject}`, detail: m.text.slice(0, 1000), href: `/inbox?id=${m.id}`, projectNumber: pn(m.projectId) });
  const emails = await db.select().from(outboundEmails).where(eq(outboundEmails.customerId, customerId));
  for (const e of emails) out.push({ at: iso(e.createdAt)!, kind: "email", title: `E-mail: ${e.subject}`, detail: e.status === "failed" ? `Niet afgeleverd: ${e.error ?? ""}` : e.status === "not_sent" ? "Vastgelegd, niet verstuurd" : `Aan ${e.toAddress}` });

  if (projectIds.length && can("projects.read")) {
    const hist = await db
      .select({ h: projectStatusHistory, status: journeyStatuses.name, by: users.name })
      .from(projectStatusHistory)
      .innerJoin(journeyStatuses, eq(journeyStatuses.id, projectStatusHistory.toStatusId))
      .leftJoin(users, eq(users.id, projectStatusHistory.changedBy))
      .where(inArray(projectStatusHistory.projectId, projectIds));
    for (const { h, status, by } of hist) {
      out.push({ at: iso(h.changedAt)!, kind: "status", title: `Status: ${status}`, detail: h.note, by: by ?? "Systeem", projectNumber: pn(h.projectId), href: `/projecten/${h.projectId}` });
    }
  }
  if (projectIds.length && can("planning.read")) {
    const appts = await db
      .select({ a: appointments, partner: organizations.name })
      .from(appointments)
      .innerJoin(organizations, eq(organizations.id, appointments.partnerOrganizationId))
      .where(inArray(appointments.projectId, projectIds));
    for (const { a, partner } of appts) {
      const what = a.type === "survey" ? "Schouw" : "Installatie";
      const state = a.status === "planned" ? "ingepland" : a.status === "completed" ? "uitgevoerd" : a.status === "partner_no_show" ? "partner niet gekomen" : "geannuleerd";
      out.push({ at: iso(a.createdAt)!, kind: "appointment", title: `${what} ${state} voor ${a.date}`, detail: [partner, a.cancelReason].filter(Boolean).join(" · "), projectNumber: pn(a.projectId), href: `/projecten/${a.projectId}` });
    }
  }
  if (can("quotes.read")) {
    const qs = await db.select().from(quotes).where(and(eq(quotes.customerId, customerId), ne(quotes.status, "draft")));
    for (const q of qs) {
      if (q.sentAt) out.push({ at: iso(q.sentAt)!, kind: "quote", title: `Offerte ${formatQuoteNumber(q.number)} verstuurd`, href: `/offertes/${q.id}`, projectNumber: pn(q.projectId) });
      if (q.acceptedAt) out.push({ at: iso(q.acceptedAt)!, kind: "quote", title: `Offerte ${formatQuoteNumber(q.number)} geaccepteerd`, detail: q.acceptedByName, href: `/offertes/${q.id}`, projectNumber: pn(q.projectId) });
      if (q.status === "rejected" && q.rejectedAt) out.push({ at: iso(q.rejectedAt)!, kind: "quote", title: `Offerte ${formatQuoteNumber(q.number)} afgewezen`, detail: q.rejectionReason, href: `/offertes/${q.id}` });
    }
  }
  if (can("invoices.read")) {
    const invs = await db.select().from(invoices).where(and(eq(invoices.customerId, customerId), ne(invoices.status, "draft")));
    for (const i of invs) {
      out.push({ at: iso(i.createdAt)!, kind: "invoice", title: `${i.type === "credit" ? "Creditnota" : "Factuur"} ${i.number}`, detail: `€ ${(i.totalCents / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2 })}`, href: `/facturen/${i.id}`, projectNumber: pn(i.projectId) });
    }
    if (invs.length) {
      const pays = await db.select().from(payments).where(and(inArray(payments.invoiceId, invs.map((i) => i.id)), eq(payments.status, "paid")));
      for (const p of pays) {
        const inv = invs.find((i) => i.id === p.invoiceId)!;
        out.push({ at: iso(p.paidAt ?? p.createdAt)!, kind: "payment", title: `Betaling ontvangen voor ${inv.number}`, detail: `€ ${(p.amountCents / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2 })}`, href: `/facturen/${inv.id}` });
      }
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}

export async function addNote(db: DbOrTx, actor: ActorContext, customerId: string, input: { kind: "note" | "call"; body: string; projectId?: string | null }) {
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Klant");
  if (input.projectId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.customerId, customerId)));
    if (!p) throw notFound("Project");
  }
  const [n] = await db.insert(customerNotes).values({ customerId, projectId: input.projectId ?? null, kind: input.kind, body: input.body.trim(), createdBy: actor.userId }).returning();
  await recordAudit(db, actor, { action: "customer.note_added", entityType: "customer", entityId: customerId, metadata: { kind: input.kind, projectId: input.projectId ?? null } });
  return n!;
}

// ---------------------------------------------------------------- Zoeken

/**
 * Zoeken over klanten (naam, e-mail, telefoon, klantnummer, postcode, straat), projecten, offertes en facturen (nummer).
 * Elk onderdeel alleen met het leesrecht. Maximaal 8 resultaten per soort.
 */
export async function search(db: DbOrTx, actor: ActorContext, qInput: string) {
  const can = (p: string) => actor.permissions.has(p as never);
  const q = qInput.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = q.replace(/\D/g, "");
  const num = /^[a-z]?-?\d+$/i.test(q.replace(/\s/g, "")) && digits ? Number(digits) : null;
  const postal = q.replace(/\s/g, "").toUpperCase();
  const results: { kind: string; label: string; detail: string; href: string }[] = [];

  if (can("customers.read")) {
    // Losse, elk via een index uit te voeren zoekopdrachten (migratie 0029), samengevoegd met UNION.
    const parts = [
      sql`SELECT id FROM customers WHERE (coalesce(first_name, '') || ' ' || last_name) ILIKE ${like}`,
      sql`SELECT id FROM customers WHERE email ILIKE ${like}`,
      sql`SELECT customer_id AS id FROM properties WHERE replace(upper(postal_code), ' ', '') LIKE ${`${postal}%`}`,
      sql`SELECT customer_id AS id FROM properties WHERE (street || ' ' || house_number) ILIKE ${like}`,
    ];
    if (digits.length >= 6) parts.push(sql`SELECT id FROM customers WHERE regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ${`%${digits.slice(-9)}%`}`);
    if (num !== null && /^k/i.test(q)) parts.push(sql`SELECT id FROM customers WHERE number = ${num}`);
    const ids = ((await db.execute(sql`SELECT DISTINCT id FROM (${sql.join(parts, sql` UNION `)}) u LIMIT 8`)).rows as { id: string }[]).map((r) => r.id);
    if (ids.length) {
      const rows = await db
        .select({ c: customers, street: properties.street, houseNumber: properties.houseNumber, city: properties.city })
        .from(customers)
        .leftJoin(properties, eq(properties.customerId, customers.id))
        .where(inArray(customers.id, ids));
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.c.id)) continue;
        seen.add(r.c.id);
        results.push({
          kind: "Klant",
          label: [r.c.firstName, r.c.lastName].filter(Boolean).join(" "),
          detail: [formatCustomerNumber(r.c.number), r.street && `${r.street} ${r.houseNumber}, ${r.city}`, r.c.email].filter(Boolean).join(" · "),
          href: `/klanten/${r.c.id}`,
        });
      }
    }
  }
  if (num !== null) {
    if (can("projects.read") && (!/^[a-z]/i.test(q) || /^p/i.test(q))) {
      const ps = await db
        .select({ p: projects, c: customers })
        .from(projects)
        .innerJoin(customers, eq(customers.id, projects.customerId))
        .where(eq(projects.number, num))
        .limit(3);
      for (const { p, c } of ps) results.push({ kind: "Project", label: formatProjectNumber(p.number), detail: [c.firstName, c.lastName].filter(Boolean).join(" "), href: `/projecten/${p.id}` });
    }
    if (can("quotes.read") && (!/^[a-z]/i.test(q) || /^o/i.test(q))) {
      const qs = await db.select({ q: quotes, c: customers }).from(quotes).innerJoin(customers, eq(customers.id, quotes.customerId)).where(eq(quotes.number, num)).limit(3);
      for (const { q: qu, c } of qs) results.push({ kind: "Offerte", label: formatQuoteNumber(qu.number), detail: [c.firstName, c.lastName].filter(Boolean).join(" "), href: `/offertes/${qu.id}` });
    }
  }
  if (can("invoices.read") && digits.length >= 1) {
    const inv = await db
      .select({ i: invoices, c: customers })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(sql`${invoices.number} ILIKE ${`%${digits.padStart(Math.min(6, digits.length), "0")}%`} AND (${/^f/i.test(q) || q.includes("-") || digits.length >= 4})`)
      .orderBy(desc(invoices.createdAt))
      .limit(5);
    for (const { i, c } of inv) results.push({ kind: i.type === "credit" ? "Creditnota" : "Factuur", label: i.number!, detail: [c.firstName, c.lastName].filter(Boolean).join(" "), href: `/facturen/${i.id}` });
  }
  return results;
}
