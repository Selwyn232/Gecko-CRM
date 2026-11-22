import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { emitEvent } from "../events/service.js";
import { organizations } from "../organizations/schema.js";
import type { WhatsappHint } from "../whatsapp/service.js";
import { invoices } from "../invoices/schema.js";
import { journeyStatuses } from "../journeys/schema.js";
import { appointments } from "../planning/schema.js";
import { projects } from "../projects/schema.js";
import { quotes } from "../quotes/schema.js";
import { HEAD_END, HEAD_START, JOURNEY_SLOT, journeyBar, specialistHead, specialistSignature } from "./layout.js";
import { outboundEmails } from "./schema.js";
import type { EmailMessage, EmailTransport } from "./transport.js";

export interface SendEmailInput extends EmailMessage {
  template: string;
  customerId?: string | null;
  related?: { type: string; id: string };
  /** Zelfde sleutel = niet nogmaals versturen. */
  dedupeKey?: string;
  /** Eigen WhatsApp-sjabloon voor deze e-mail (anders het algemene sjabloon "gecko_bericht"), B83. */
  whatsapp?: WhatsappHint | null;
}

/** Uitkomst van elke verzending in de serverlogs (zonder inhoud of ontvanger), voor diagnose. */
function logEmail(level: "info" | "error", data: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({ level: level === "error" ? 50 : 30, time: Date.now(), msg: "email", ...data });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Legt de e-mail vast en verstuurt hem (als er een transport is ingesteld).
 * Een mislukte verzending gooit geen fout naar de gebruiker; de status wordt "failed" met de reden.
 */
/** Merknaam zonder rechtsvorm: "Gecko BV" → "Gecko". */
export const brandName = (companyName: string) => companyName.replace(/\s+B\.?V\.?$/i, "").trim() || companyName;

/** Afzendernaam "Voornaam | Gecko" van een medewerker (of null). */
export async function staffSenderName(db: DbOrTx, userId: string | null | undefined) {
  if (!userId) return null;
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  if (!u) return null;
  const [company] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.type, "gecko")).limit(1);
  return `${u.name.trim().split(/\s+/)[0]} | ${brandName(company?.name ?? "Gecko")}`;
}

/** Project waar deze mail over gaat (voor de voortgangsbalk). */
async function projectOf(db: DbOrTx, input: SendEmailInput): Promise<string | null> {
  const r = input.related;
  if (r?.type === "project") return r.id;
  if (r?.type === "appointment") return (await db.select({ p: appointments.projectId }).from(appointments).where(eq(appointments.id, r.id)))[0]?.p ?? null;
  if (r?.type === "invoice") return (await db.select({ p: invoices.projectId }).from(invoices).where(eq(invoices.id, r.id)))[0]?.p ?? null;
  if (r?.type === "quote") return (await db.select({ p: quotes.projectId }).from(quotes).where(eq(quotes.id, r.id)))[0]?.p ?? null;
  if (!input.customerId) return null;
  // Anders: het enige lopende project van de klant (bij meerdere is niet duidelijk welk bedoeld is).
  const open = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(and(eq(projects.customerId, input.customerId), eq(journeyStatuses.isFinal, false)));
  return open.length === 1 ? open[0]!.id : null;
}

const PHASE_LABEL: Record<string, string> = { Verkoop: "Order" };

/** Stappen (fasen) van de klantreis van het project en de huidige stap. Geannuleerd = geen balk. */
async function journeyProgress(db: DbOrTx, projectId: string) {
  const [p] = await db
    .select({ project: projects, status: journeyStatuses })
    .from(projects)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(eq(projects.id, projectId));
  if (!p || p.status.key === "geannuleerd") return null;
  const all = await db
    .select()
    .from(journeyStatuses)
    .where(and(eq(journeyStatuses.productGroupId, p.project.productGroupId), p.status.salesChannelId ? eq(journeyStatuses.salesChannelId, p.status.salesChannelId) : isNull(journeyStatuses.salesChannelId)))
    .orderBy(asc(journeyStatuses.sortOrder));
  const phases: string[] = [];
  for (const st of all) {
    if (st.key === "geannuleerd" || phases.includes(st.phase)) continue;
    // Financiering alleen tonen als die voor deze klant speelt.
    if (st.phase === "Financiering" && p.project.paymentMethod !== "warmtefonds" && p.status.phase !== "Financiering") continue;
    phases.push(st.phase);
  }
  const current = p.status.key === "afgerond" ? phases.length : phases.indexOf(p.status.phase);
  return { steps: phases.map((ph) => PHASE_LABEL[ph] ?? ph), current };
}

/** B81/B84: kop met de vaste klantspecialist en onderaan de voortgang in de klantreis. */
async function personalize(db: DbOrTx, input: SendEmailInput): Promise<string> {
  let html = input.html;
  if (!html || !input.customerId || !html.includes(HEAD_START)) return html;
  const [c] = await db.select({ s: customers.specialistUserId }).from(customers).where(eq(customers.id, input.customerId));
  if (c?.s) {
    const [u] = await db.select({ id: users.id, name: users.name, photo: users.photoDataUrl }).from(users).where(eq(users.id, c.s));
    if (u) {
      const [company] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.type, "gecko")).limit(1);
      const base = process.env.APP_BASE_URL?.replace(/\/$/, "");
      const head = specialistHead({ name: u.name, photoUrl: u.photo && base ? `${base}/api/public/specialists/${u.id}/photo` : null, brand: brandName(company?.name ?? "Gecko") });
      const start = html.indexOf(HEAD_START);
      const end = html.indexOf(HEAD_END);
      if (end > start) html = html.slice(0, start) + head + html.slice(end + HEAD_END.length);
      const brand = brandName(company?.name ?? "Gecko");
      if (!/met vriendelijke groet/i.test(html)) html = html.replace(JOURNEY_SLOT, specialistSignature({ name: u.name, brand }) + JOURNEY_SLOT);
    }
  }
  const projectId = await projectOf(db, input);
  const progress = projectId ? await journeyProgress(db, projectId) : null;
  return html.replace(JOURNEY_SLOT, progress ? journeyBar(progress.steps, progress.current) : "");
}

export async function sendEmail(db: DbOrTx, transport: EmailTransport | null, input: SendEmailInput) {
  // B84: mail aan een klant komt van zijn vaste klantspecialist ("Ingrid | Gecko"), zolang die er is.
  if (input.fromName === undefined && input.customerId) {
    const [c] = await db.select({ s: customers.specialistUserId }).from(customers).where(eq(customers.id, input.customerId));
    input = { ...input, fromName: await staffSenderName(db, c?.s) };
  }
  if (input.dedupeKey) {
    const [existing] = await db.select().from(outboundEmails).where(eq(outboundEmails.dedupeKey, input.dedupeKey));
    if (existing) return existing;
  }
  input = { ...input, html: await personalize(db, input) };
  const [row] = await db
    .insert(outboundEmails)
    .values({
      toAddress: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      template: input.template,
      customerId: input.customerId ?? null,
      relatedType: input.related?.type ?? null,
      relatedId: input.related?.id ?? null,
      dedupeKey: input.dedupeKey ?? null,
      status: transport ? "queued" : "not_sent",
      provider: transport?.name ?? null,
    })
    .returning();
  // B83: alles wat per e-mail naar een klant gaat, gaat ook via WhatsApp (via de outbox, dus los van deze verzending).
  if (input.customerId) {
    await emitEvent(db, "whatsapp.mirror", { type: "email", id: row!.id }, { emailId: row!.id, hint: input.whatsapp ?? null });
  }
  if (!transport) return row!;
  try {
    const { providerMessageId } = await transport.send(input);
    logEmail("info", { emailId: row!.id, template: input.template, status: "sent", provider: transport.name, providerMessageId });
    const [sent] = await db
      .update(outboundEmails)
      .set({ status: "sent", providerMessageId, sentAt: new Date() })
      .where(eq(outboundEmails.id, row!.id))
      .returning();
    return sent!;
  } catch (err) {
    logEmail("error", { emailId: row!.id, template: input.template, status: "failed", provider: transport.name, error: err instanceof Error ? err.message : String(err) });
    const [failed] = await db
      .update(outboundEmails)
      .set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 1000) : String(err) })
      .where(eq(outboundEmails.id, row!.id))
      .returning();
    return failed!;
  }
}

export function listEmails(db: DbOrTx, q: { relatedType?: string; relatedId?: string; customerId?: string }) {
  const filters: SQL[] = [];
  if (q.customerId) filters.push(eq(outboundEmails.customerId, q.customerId));
  if (q.relatedType) filters.push(eq(outboundEmails.relatedType, q.relatedType));
  if (q.relatedId) filters.push(eq(outboundEmails.relatedId, q.relatedId));
  return db
    .select()
    .from(outboundEmails)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(outboundEmails.createdAt))
    .limit(100);
}
