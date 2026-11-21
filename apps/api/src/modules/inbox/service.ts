import { ownCustomerFilter } from "../specialists/service.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { customers } from "../customers/schema.js";
import { escapeHtml, layout } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { projects } from "../projects/schema.js";
import { getCompany } from "../quotes/links.js";
import { notifyPermission } from "../tasks/service.js";
import { inboundEmails } from "./schema.js";

/** Mailgun-handtekening: HMAC-SHA256(timestamp + token) met de webhook-sleutel; max. 15 minuten oud. */
export function verifyMailgunSignature(signingKey: string, timestamp: string, token: string, signature: string, now = Date.now()) {
  if (!timestamp || !token || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 900) return false;
  const expected = createHmac("sha256", signingKey).update(timestamp + token).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const parseFrom = (from: string) => {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1]!.trim() || null, address: m[2]!.trim().toLowerCase() } : { name: null, address: from.trim().toLowerCase() };
};

/** Binnenkomende mail opslaan en koppelen. Dubbel afgeleverde berichten (zelfde Message-Id) worden genegeerd. */
export async function receiveInbound(
  db: Db,
  input: { from: string; to: string; subject: string; strippedText?: string | null; bodyPlain?: string | null; messageId?: string | null; attachmentCount?: number },
) {
  const from = parseFrom(input.from);
  if (input.messageId) {
    const [dup] = await db.select({ id: inboundEmails.id }).from(inboundEmails).where(eq(inboundEmails.messageId, input.messageId));
    if (dup) return { id: dup.id, duplicate: true };
  }
  // Klanten met dit afzenderadres (soms meerdere, bv. een gezin of testklanten); de nieuwste eerst.
  const matches = await db
    .select({ id: customers.id })
    .from(customers)
    .where(sql`lower(${customers.email}) = ${from.address}`)
    .orderBy(desc(customers.createdAt));
  let customer: { id: string } | undefined = matches[0];
  let projectId: string | null = null;
  const pn = input.subject.match(/\bP-?0*(\d{1,9})\b/i);
  if (pn) {
    const [p] = await db.select({ id: projects.id, customerId: projects.customerId }).from(projects).where(eq(projects.number, Number(pn[1])));
    // Het projectnummer in het onderwerp beslist bij welke klant de mail hoort (als de afzender bij die klant hoort).
    if (p && (!matches.length || matches.some((m) => m.id === p.customerId))) {
      projectId = p.id;
      customer = { id: p.customerId };
    }
  }
  const [row] = await db
    .insert(inboundEmails)
    .values({
      messageId: input.messageId ?? null,
      fromAddress: from.address,
      fromName: from.name,
      toAddress: input.to.slice(0, 500),
      subject: input.subject.slice(0, 500) || "(geen onderwerp)",
      text: (input.strippedText || input.bodyPlain || "").slice(0, 50_000),
      fullText: input.bodyPlain ? input.bodyPlain.slice(0, 200_000) : null,
      attachmentCount: input.attachmentCount ? String(input.attachmentCount) : null,
      customerId: customer?.id ?? null,
      projectId,
    })
    .returning();
  await notifyPermission(db, "customers.manage", {
    title: `Nieuwe e-mail van ${from.name ?? from.address}`,
    body: input.subject.slice(0, 200),
    href: `/inbox?id=${row!.id}`,
    dedupeKey: `inbound:${row!.id}`,
  });
  return { id: row!.id, duplicate: false };
}

export async function listInbound(db: DbOrTx, q: { status?: "new" | "handled"; customerId?: string }, actor?: ActorContext) {
  const filters = [];
  // Klantspecialist: alleen mail van eigen klanten; niet-gekoppelde mail verdeelt de manager (B81).
  const own = actor && ownCustomerFilter(actor, inboundEmails.customerId);
  if (own) filters.push(own);
  if (q.status) filters.push(eq(inboundEmails.status, q.status));
  if (q.customerId) filters.push(eq(inboundEmails.customerId, q.customerId));
  const rows = await db
    .select({ e: inboundEmails, firstName: customers.firstName, lastName: customers.lastName, projectNumber: projects.number })
    .from(inboundEmails)
    .leftJoin(customers, eq(customers.id, inboundEmails.customerId))
    .leftJoin(projects, eq(projects.id, inboundEmails.projectId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(200);
  return rows.map((r) => ({
    ...r.e,
    fullText: undefined,
    customerName: r.lastName ? [r.firstName, r.lastName].filter(Boolean).join(" ") : null,
    projectNumber: r.projectNumber ? `P-${String(r.projectNumber).padStart(6, "0")}` : null,
  }));
}

export async function updateInbound(db: DbOrTx, actor: ActorContext, id: string, input: { customerId?: string | null; status?: "new" | "handled" }) {
  const [before] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
  if (!before) throw notFound("E-mail");
  const patch: Partial<typeof inboundEmails.$inferInsert> = {};
  if (input.customerId !== undefined) {
    if (input.customerId) {
      const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
      if (!c) throw notFound("Klant");
    }
    patch.customerId = input.customerId;
  }
  if (input.status) {
    patch.status = input.status;
    patch.handledBy = input.status === "handled" ? actor.userId : null;
    patch.handledAt = input.status === "handled" ? new Date() : null;
  }
  const [row] = await db.update(inboundEmails).set(patch).where(eq(inboundEmails.id, id)).returning();
  await recordAudit(db, actor, { action: "inbound.updated", entityType: "inbound_email", entityId: id, before: { customerId: before.customerId, status: before.status }, after: { customerId: row!.customerId, status: row!.status } });
  return row!;
}

/** Antwoorden vanuit het CRM: e-mail aan de afzender (vastgelegd op de klantkaart) en bericht wordt afgehandeld. */
export async function replyInbound(db: Db, transport: EmailTransport | null, actor: ActorContext, id: string, text: string) {
  const [m] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
  if (!m) throw notFound("E-mail");
  if (!text.trim()) throw badRequest("empty", "Schrijf eerst een antwoord");
  const company = await getCompany(db);
  const quoted = m.text.split("\n").slice(0, 40).map((l) => `> ${l}`).join("\n");
  const html = `${text.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("")}<hr style="border:0;border-top:1px solid #dfe3dd;margin:20px 0"><p style="color:#5f6b62;font-size:13px">Op ${m.receivedAt.toLocaleString("nl-NL")} schreef ${escapeHtml(m.fromName ?? m.fromAddress)}:<br>${escapeHtml(m.text.slice(0, 3000)).replace(/\n/g, "<br>")}</p>`;
  const sent = await sendEmail(db, transport, {
    to: m.fromAddress,
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    html: layout(company, html),
    text: `${text.trim()}\n\n${quoted}`,
    template: "inbox.reply",
    customerId: m.customerId,
    related: { type: "inbound_email", id },
  });
  await updateInbound(db, actor, id, { status: "handled" });
  return { status: sent.status, error: sent.error };
}
