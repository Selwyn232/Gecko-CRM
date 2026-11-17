import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { customers } from "../customers/schema.js";
import { invoices } from "../invoices/schema.js";
import { organizations } from "../organizations/schema.js";
import { listOrganizations } from "../organizations/service.js";
import { reports } from "../planning/schema.js";
import { addDays, listAppointments, toPlan } from "../planning/service.js";
import { formatProjectNumber } from "../projects/service.js";
import { projects } from "../projects/schema.js";
import { stuckProjects } from "../reports/service.js";
import { quotes } from "../quotes/schema.js";
import { formatQuoteNumber } from "../quotes/service.js";
import { selfBillingInvoices } from "../selfbilling/schema.js";
import { openItems } from "../selfbilling/service.js";
import { dueTasks } from "../tasks/service.js";
import { inboundEmails } from "../inbox/schema.js";

export interface WorkItem {
  label: string;
  detail?: string;
  /** Pad in het CRM. */
  href: string;
  /** Hoe lang of tot wanneer, voor de volgorde en weergave. */
  date?: string | null;
}
export interface WorkSection {
  key: string;
  title: string;
  /** Uitleg wat hier te doen is. */
  hint: string;
  severity: "high" | "normal";
  count: number;
  items: WorkItem[];
  /** "Alles bekijken". */
  href: string;
}

const LIMIT = 8;
const name = (c: { firstName: string | null; lastName: string }) => [c.firstName, c.lastName].filter(Boolean).join(" ");

/** Alles wat aandacht nodig heeft, alleen de onderdelen waar de gebruiker rechten voor heeft. Lege onderdelen vallen weg. */
export async function myWork(db: DbOrTx, actor: ActorContext) {
  const can = (p: string) => actor.permissions.has(p as never);
  const today = todayIso();
  const sections: WorkSection[] = [];
  const add = (s: WorkSection) => s.count > 0 && sections.push(s);

  if (actor.userId) {
    const mine = await dueTasks(db, actor.userId, addDays(today, 7));
    add({
      key: "tasks",
      title: "Mijn taken",
      hint: "Open taken met een deadline binnen 7 dagen (of zonder deadline). Afvinken op de klantkaart.",
      severity: mine.some((t) => t.dueDate && t.dueDate < today) ? "high" : "normal",
      count: mine.length,
      items: mine.slice(0, LIMIT).map((t) => ({
        label: t.title,
        detail: t.dueDate ? `${t.dueDate < today ? "Te laat · " : ""}deadline ${t.dueDate}` : "geen deadline",
        href: t.customerId ? `/klanten/${t.customerId}` : "/werk",
        date: t.dueDate,
      })),
      href: "/werk",
    });
  }

  if (can("customers.read")) {
    const inbox = await db.select().from(inboundEmails).where(eq(inboundEmails.status, "new")).orderBy(asc(inboundEmails.receivedAt));
    add({
      key: "inbox",
      title: "Inbox: nieuwe e-mails",
      hint: "Binnengekomen e-mails van klanten; beantwoord of handel af.",
      severity: inbox.some((m) => Date.now() - m.receivedAt.getTime() > 2 * 86_400_000) ? "high" : "normal",
      count: inbox.length,
      items: inbox.slice(0, LIMIT).map((m) => ({ label: m.fromName ?? m.fromAddress, detail: m.subject, href: `/inbox?id=${m.id}`, date: m.receivedAt.toISOString() })),
      href: "/inbox",
    });
  }

  if (can("planning.read")) {
    const pending = await db
      .select({ r: reports, project: projects, customer: customers })
      .from(reports)
      .innerJoin(sql`appointments a`, sql`a.id = ${reports.appointmentId}`)
      .innerJoin(projects, sql`${projects.id} = a.project_id`)
      .innerJoin(customers, eq(customers.id, projects.customerId))
      .where(eq(reports.review, "pending"))
      .orderBy(asc(reports.submittedAt));
    add({
      key: "reports",
      title: "Rapporten beoordelen",
      hint: "Ingediend door installateurs; na goedkeuring gaat het project verder (of wordt meerwerk aangeboden).",
      severity: "high",
      count: pending.length,
      items: pending.slice(0, LIMIT).map(({ r, project, customer }) => ({
        label: `${r.type === "survey" ? "Schouwrapport" : "Opleverrapport"} — ${name(customer)}`,
        detail: `${formatProjectNumber(project.number)}${r.positive ? "" : " · negatief"}`,
        href: `/rapporten/${r.id}`,
        date: r.submittedAt.toISOString(),
      })),
      href: "/planning",
    });

    const unpaid = (await listAppointments(db, { status: "planned", from: today, to: addDays(today, 60) })) as Awaited<ReturnType<typeof listAppointments>>;
    const flagged = unpaid.filter((a) => (a as { depositUnpaid?: boolean }).depositUnpaid);
    add({
      key: "deposit",
      title: "Schouw gepland, aanbetaling open",
      hint: "De aanbetaling moet vóór de schouw binnen zijn. Neem contact op met de klant of verzet de schouw.",
      severity: "high",
      count: flagged.length,
      items: flagged.slice(0, LIMIT).map((a) => ({ label: name(a.customer), detail: `${a.projectNumber} · schouw ${a.date}`, href: `/projecten/${a.projectId}`, date: a.date })),
      href: "/planning",
    });

    for (const type of ["survey", "installation"] as const) {
      const list = await toPlan(db, type);
      add({
        key: `toplan-${type}`,
        title: type === "survey" ? "Schouw inplannen" : "Installatie inplannen",
        hint: "Projecten die klaar zijn om in te plannen, langst wachtend eerst.",
        severity: "normal",
        count: list.length,
        items: list.slice(0, LIMIT).map((p) => ({ label: p.customerName, detail: `${p.projectNumber} · ${p.productGroupName} · ${p.city}`, href: `/projecten/${p.projectId}`, date: String(p.waitingSince) })),
        href: "/planning",
      });
    }
  }

  if (can("quotes.read")) {
    const extraDrafts = await db
      .select({ q: quotes, customer: customers })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(eq(quotes.kind, "extra_work"), eq(quotes.status, "draft")))
      .orderBy(asc(quotes.createdAt));
    add({
      key: "extra-drafts",
      title: "Meerwerk-offerte versturen",
      hint: "Aangemaakt uit een goedgekeurd schouwrapport; controleer en verstuur ter akkoord aan de klant.",
      severity: "high",
      count: extraDrafts.length,
      items: extraDrafts.slice(0, LIMIT).map(({ q, customer }) => ({ label: name(customer), detail: formatQuoteNumber(q.number), href: `/offertes/${q.id}`, date: q.createdAt.toISOString() })),
      href: "/offertes",
    });
    const waiting = await db
      .select({ q: quotes, customer: customers })
      .from(quotes)
      .innerJoin(customers, eq(customers.id, quotes.customerId))
      .where(and(eq(quotes.status, "sent"), gte(quotes.validUntil, today), lte(quotes.sentAt, new Date(Date.now() - 5 * 86_400_000))))
      .orderBy(asc(quotes.validUntil));
    add({
      key: "quotes-waiting",
      title: "Offertes zonder reactie (> 5 dagen)",
      hint: "Verstuurd maar nog niet geaccepteerd. Bel de klant na voordat de offerte verloopt.",
      severity: "normal",
      count: waiting.length,
      items: waiting.slice(0, LIMIT).map(({ q, customer }) => ({ label: name(customer), detail: `${formatQuoteNumber(q.number)} · geldig tot ${q.validUntil}`, href: `/offertes/${q.id}`, date: q.validUntil })),
      href: "/offertes",
    });
  }

  if (can("projects.read")) {
    const stuck = await stuckProjects(db, {}, 14);
    add({
      key: "stuck",
      title: "Blijft hangen (> 14 dagen in dezelfde status)",
      hint: "Kijk wat er nodig is om het project verder te helpen.",
      severity: "normal",
      count: stuck.length,
      items: stuck.slice(0, LIMIT).map((s) => ({ label: s.customerName, detail: `${s.projectNumber} · ${s.status.name} · ${s.days} dagen`, href: `/projecten/${s.projectId}` })),
      href: "/rapportages",
    });
  }

  if (can("invoices.read")) {
    const overdue = await db
      .select({ i: invoices, customer: customers })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(invoices.status, "open"), lt(invoices.dueDate, today), sql`${invoices.totalCents} > ${invoices.paidCents}`))
      .orderBy(asc(invoices.dueDate));
    add({
      key: "overdue",
      title: "Facturen over de vervaldatum",
      hint: "Herinneringen en aanmaningen gaan automatisch; hier zie je wie achterloopt (en wie bij incasso ligt).",
      severity: overdue.some((o) => o.i.dunningStage === "collection") ? "high" : "normal",
      count: overdue.length,
      items: overdue.slice(0, LIMIT).map(({ i, customer }) => ({
        label: name(customer),
        detail: `${i.number} · vervallen ${i.dueDate}${i.dunningStage !== "none" ? ` · ${i.dunningStage === "collection" ? "incasso" : i.dunningStage === "formal_notice" ? "14-dagenbrief" : "herinnering"}` : ""}`,
        href: `/facturen/${i.id}`,
        date: i.dueDate,
      })),
      href: "/facturen",
    });

    const sb = await db
      .select({ i: selfBillingInvoices, partner: organizations.name })
      .from(selfBillingInvoices)
      .innerJoin(organizations, eq(organizations.id, selfBillingInvoices.partnerOrganizationId))
      .where(and(eq(selfBillingInvoices.status, "final"), inArray(selfBillingInvoices.approvalStatus, ["approved", "disputed"])))
      .orderBy(desc(selfBillingInvoices.approvalStatus), asc(selfBillingInvoices.invoiceDate));
    const disputed = sb.filter((x) => x.i.approvalStatus === "disputed");
    add({
      key: "sb-disputed",
      title: "Selfbilling: niet akkoord",
      hint: "De partner is niet akkoord. Overleg en stuur daarna opnieuw ter akkoord.",
      severity: "high",
      count: disputed.length,
      items: disputed.slice(0, LIMIT).map(({ i, partner }) => ({ label: partner, detail: `${i.number} · ${i.disputeReason ?? ""}`, href: `/selfbilling/${i.id}` })),
      href: "/selfbilling",
    });
    const approved = sb.filter((x) => x.i.approvalStatus === "approved");
    add({
      key: "sb-approved",
      title: "Selfbilling uitbetalen",
      hint: "Geaccordeerd door de partner; maak het bedrag over en markeer als betaald.",
      severity: "normal",
      count: approved.length,
      items: approved.slice(0, LIMIT).map(({ i, partner }) => ({ label: partner, detail: `${i.number} · € ${(i.totalCents / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2 })}`, href: `/selfbilling/${i.id}` })),
      href: "/selfbilling",
    });
    const ready = (await openItems(db)).filter((p) => p.canBill);
    add({
      key: "sb-ready",
      title: "Selfbilling klaar om te factureren",
      hint: "Uitbetaalbare posten; maak per partner een conceptfactuur.",
      severity: "normal",
      count: ready.length,
      items: ready.slice(0, LIMIT).map((p) => ({ label: p.partner.name, detail: `${p.items.filter((i) => i.amountCents !== null).length} posten`, href: "/selfbilling" })),
      href: "/selfbilling",
    });
  }

  if (can("organizations.read")) {
    const partners = (await listOrganizations(db, { type: "installation_partner", isActive: true })) as Awaited<ReturnType<typeof listOrganizations>>;
    const noAccount = partners.filter((p) => p.userCount === 0);
    add({
      key: "partners-no-account",
      title: "Installatiepartner zonder account",
      hint: "Elke installatiepartner heeft een eigen account nodig voor opdrachten, beschikbaarheid en rapporten. Maak het aan bij Organisaties.",
      severity: "high",
      count: noAccount.length,
      items: noAccount.slice(0, LIMIT).map((p) => ({ label: p.name, detail: "Nog geen account", href: "/organisaties" })),
      href: "/organisaties",
    });
    const noGroups = partners.filter((p) => !p.productGroupIds.length);
    add({
      key: "partners-no-groups",
      title: "Installatiepartner zonder productgroepen",
      hint: "Stel in welke productgroepen de partner installeert; tot die tijd wordt hij voor alles voorgesteld.",
      severity: "normal",
      count: noGroups.length,
      items: noGroups.slice(0, LIMIT).map((p) => ({ label: p.name, detail: "Productgroepen niet ingesteld", href: "/organisaties" })),
      href: "/organisaties",
    });
  }

  return { sections, generatedAt: new Date().toISOString() };
}


