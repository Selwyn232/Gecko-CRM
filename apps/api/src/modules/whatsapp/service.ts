import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { users } from "../auth/schema.js";
import { customers } from "../customers/schema.js";
import { outboundEmails } from "../email/schema.js";
import { getCompany } from "../quotes/links.js";
import { ownCustomerFilter } from "../specialists/service.js";
import { notify, notifyPermission } from "../tasks/service.js";
import { whatsappMessages } from "./schema.js";
import type { WhatsappTransport } from "./transport.js";

/**
 * WhatsApp (B83). Alles wat per e-mail naar een klant gaat, gaat ook via WhatsApp:
 * - binnen 24 uur na het laatste bericht van de klant als gewone tekst (de tekst van de e-mail);
 * - daarbuiten met een door Meta goedgekeurd sjabloon (zie SJABLONEN en docs/14-whatsapp.md).
 * Klanten kunnen zelf berichten sturen; die komen bij hun klantspecialist (B81).
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WhatsappDeps {
  whatsappTransport: WhatsappTransport | null;
  config: Pick<Config, "APP_BASE_URL" | "WHATSAPP_TEMPLATE_LANGUAGE">;
}

/** De sjablonen die in WhatsApp Manager moeten worden aangemaakt (categorie Utility, taal Nederlands). */
export const SJABLONEN = {
  bericht: {
    name: "gecko_bericht",
    header: null,
    text: "Beste {{1}}, u heeft een nieuw bericht van Gecko: *{{2}}*. U vindt het volledige bericht in uw e-mail. Heeft u een vraag? Reageer gewoon op dit WhatsApp-bericht.",
    example: ["Jan", "Uw installatie is ingepland"],
  },
  welkom: {
    name: "gecko_welkom",
    header: "image",
    text: "Beste {{1}}, welkom bij Gecko! {{2}} is vanaf nu uw vaste contactpersoon en regelt alles voor u, van de planning tot en met de installatie. Heeft u een vraag? Stuur gewoon een bericht naar dit nummer.",
    example: ["Jan", "Ingrid de Wit"],
  },
  nieuweContactpersoon: {
    name: "gecko_nieuwe_contactpersoon",
    header: "image",
    text: "Beste {{1}}, vanaf nu helpt {{2}} u verder als uw vaste contactpersoon bij Gecko. Uw dossier is volledig overgedragen, u hoeft niets opnieuw uit te leggen. Heeft u een vraag? Stuur gewoon een bericht naar dit nummer.",
    example: ["Jan", "Mark Bakker"],
  },
  contact: {
    name: "gecko_contact",
    header: null,
    text: "Beste {{1}}, {{2}} van Gecko wil graag contact met u over uw project. Reageer op dit bericht, dan helpen wij u verder.",
    example: ["Jan", "Ingrid"],
  },
} as const;

/** Deze e-mails gaan alleen per e-mail (beveiligingscodes, antwoorden op e-mails, interne tests). */
const EMAIL_ONLY = new Set(["portal.login", "quote.code", "inbox.reply", "message.test"]);

/** Nederlands of internationaal mobiel nummer (+316…, of buitenland) → wa_id zonder +. Vaste nummers: null. */
export function waIdFor(phone: string | null | undefined) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  const e164 = digits.startsWith("+") ? digits : digits.startsWith("00") ? `+${digits.slice(2)}` : digits.startsWith("06") ? `+31${digits.slice(1)}` : null;
  if (!e164) return null;
  if (e164.startsWith("+31") && !e164.startsWith("+316")) return null;
  return e164.slice(1);
}

/** Is het 24-uursvenster open (klant stuurde de afgelopen 24 uur een bericht)? */
export async function windowOpen(db: DbOrTx, waId: string) {
  const [last] = await db
    .select({ at: whatsappMessages.createdAt })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.waId, waId), eq(whatsappMessages.direction, "in")))
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(1);
  return !!last && Date.now() - last.at.getTime() < WINDOW_MS;
}

async function record(db: DbOrTx, values: typeof whatsappMessages.$inferInsert) {
  const [row] = await db.insert(whatsappMessages).values(values).returning();
  return row!;
}

/** Versturen en vastleggen; een mislukte verzending wordt vastgelegd (status failed), niet gegooid. */
async function deliver(
  db: DbOrTx,
  deps: WhatsappDeps,
  base: { customerId: string | null; waId: string; sentBy?: string | null; emailId?: string | null },
  msg: { text: string } | { template: (typeof SJABLONEN)[keyof typeof SJABLONEN]; params: string[]; headerImageUrl?: string | null },
) {
  const isText = "text" in msg;
  const body = isText ? msg.text : msg.params.reduce((t, p, i) => t.replace(`{{${i + 1}}}`, p), msg.template.text as string);
  const row = await record(db, {
    customerId: base.customerId,
    direction: "out",
    waId: base.waId,
    kind: isText ? "text" : "template",
    body,
    templateName: isText ? null : msg.template.name,
    status: deps.whatsappTransport ? "queued" : "not_sent",
    sentBy: base.sentBy ?? null,
    emailId: base.emailId ?? null,
  });
  if (!deps.whatsappTransport) return row;
  try {
    const { providerMessageId } = isText
      ? await deps.whatsappTransport.sendText(base.waId, msg.text)
      : await deps.whatsappTransport.sendTemplate(base.waId, {
          name: msg.template.name,
          language: deps.config.WHATSAPP_TEMPLATE_LANGUAGE,
          bodyParams: msg.params,
          headerImageUrl: msg.template.header === "image" ? (msg.headerImageUrl ?? `${deps.config.APP_BASE_URL.replace(/\/$/, "")}/gecko-logo-512.png`) : null,
        });
    const [sent] = await db.update(whatsappMessages).set({ status: "sent", providerMessageId }).where(eq(whatsappMessages.id, row.id)).returning();
    return sent!;
  } catch (err) {
    const [failed] = await db
      .update(whatsappMessages)
      .set({ status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) })
      .where(eq(whatsappMessages.id, row.id))
      .returning();
    return failed!;
  }
}

// ---------------------------------------------------------------- Spiegelen van e-mails

/** Extra gegevens bij een e-mail voor het WhatsApp-sjabloon (bv. welkomstbericht met naam + foto van de specialist). */
export interface WhatsappHint {
  template: "welkom" | "nieuweContactpersoon";
  params: string[];
  headerImageUrl?: string | null;
}

/**
 * Stuurt de e-mail (outbound_emails.id) ook via WhatsApp naar de klant, als die een mobiel nummer heeft en WhatsApp
 * niet heeft uitgezet. Wordt via de outbox aangeroepen (zie jobs/outbox.ts), dus nooit dubbel per e-mail.
 */
export async function mirrorEmail(db: Db, deps: WhatsappDeps, emailId: string, hint?: WhatsappHint | null) {
  const [already] = await db.select({ id: whatsappMessages.id }).from(whatsappMessages).where(eq(whatsappMessages.emailId, emailId)).limit(1);
  if (already) return null;
  const [mail] = await db.select().from(outboundEmails).where(eq(outboundEmails.id, emailId));
  if (!mail?.customerId || EMAIL_ONLY.has(mail.template)) return null;
  const [c] = await db.select().from(customers).where(eq(customers.id, mail.customerId));
  const waId = waIdFor(c?.phone);
  if (!c || !c.whatsappEnabled || !waId) return null;
  const name = c.firstName ?? c.lastName;
  const base = { customerId: c.id, waId, emailId };
  if (await windowOpen(db, waId)) {
    // Binnen 24 uur: de volledige tekst van de e-mail als gewoon bericht.
    const text = `*${mail.subject}*\n\n${mail.text.replace(/\n{3,}/g, "\n\n").trim()}`;
    return deliver(db, deps, base, { text });
  }
  if (hint) return deliver(db, deps, base, { template: SJABLONEN[hint.template], params: hint.params, headerImageUrl: hint.headerImageUrl });
  return deliver(db, deps, base, { template: SJABLONEN.bericht, params: [name, mail.subject] });
}

// ---------------------------------------------------------------- Handmatig (vanuit het CRM)

export async function conversation(db: DbOrTx, customerId: string) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Klant");
  const waId = waIdFor(c.phone);
  const messages = await db
    .select({ m: whatsappMessages, by: users.name })
    .from(whatsappMessages)
    .leftJoin(users, eq(users.id, whatsappMessages.sentBy))
    .where(eq(whatsappMessages.customerId, customerId))
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(500);
  return {
    waId,
    enabled: c.whatsappEnabled,
    windowOpen: waId ? await windowOpen(db, waId) : false,
    messages: messages.map(({ m, by }) => ({ ...m, sentByName: by })),
  };
}

export async function markRead(db: DbOrTx, customerId: string) {
  await db
    .update(whatsappMessages)
    .set({ readAt: new Date() })
    .where(and(eq(whatsappMessages.customerId, customerId), eq(whatsappMessages.direction, "in"), isNull(whatsappMessages.readAt)));
}

/** Specialist stuurt een bericht. Binnen 24 uur vrije tekst; daarbuiten alleen het sjabloon "contact". */
export async function sendFromCrm(db: Db, deps: WhatsappDeps, actor: ActorContext, customerId: string, input: { text?: string; invite?: boolean }) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Klant");
  const waId = waIdFor(c.phone);
  if (!waId) throw badRequest("no_mobile", "Deze klant heeft geen mobiel nummer");
  if (!c.whatsappEnabled) throw conflict("whatsapp_off", "WhatsApp staat uit voor deze klant");
  const [me] = actor.userId ? await db.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)) : [];
  let row;
  if (input.invite) {
    row = await deliver(db, deps, { customerId, waId, sentBy: actor.userId }, { template: SJABLONEN.contact, params: [c.firstName ?? c.lastName, (me?.name ?? "Uw contactpersoon").split(" ")[0]!] });
  } else {
    const text = input.text?.trim();
    if (!text) throw badRequest("empty", "Typ een bericht");
    if (!(await windowOpen(db, waId))) {
      throw conflict("window_closed", "De klant heeft de afgelopen 24 uur geen bericht gestuurd. Stuur eerst een uitnodiging; zodra de klant reageert kun je vrij typen.");
    }
    row = await deliver(db, deps, { customerId, waId, sentBy: actor.userId }, { text });
  }
  await markRead(db, customerId);
  await recordAudit(db, actor, { action: "whatsapp.sent", entityType: "customer", entityId: customerId, metadata: { kind: row.kind, status: row.status } });
  return row;
}

export async function setEnabled(db: Db, actor: ActorContext, customerId: string, enabled: boolean) {
  const [c] = await db.update(customers).set({ whatsappEnabled: enabled }).where(eq(customers.id, customerId)).returning({ id: customers.id });
  if (!c) throw notFound("Klant");
  await recordAudit(db, actor, { action: enabled ? "whatsapp.enabled" : "whatsapp.disabled", entityType: "customer", entityId: customerId });
}

/** Gesprekken: per klant het laatste bericht; wie wacht op antwoord staat bovenaan, oudste eerst (B81). */
export async function listConversations(db: DbOrTx, actor: ActorContext) {
  const own = ownCustomerFilter(actor, whatsappMessages.customerId);
  const rows = await db.execute<{
    customer_id: string | null;
    wa_id: string;
    first_name: string | null;
    last_name: string | null;
    last_at: Date;
    last_body: string;
    last_direction: string;
    unread: number;
    waiting_since: Date | null;
    specialist: string | null;
  }>(sql`
    WITH last AS (
      SELECT DISTINCT ON (coalesce(m.customer_id::text, m.wa_id)) m.customer_id, m.wa_id, m.created_at, m.body, m.direction
      FROM ${whatsappMessages} m
      WHERE ${own ?? sql`true`}
      ORDER BY coalesce(m.customer_id::text, m.wa_id), m.created_at DESC
    )
    SELECT l.customer_id, l.wa_id, c.first_name, c.last_name, l.created_at AS last_at, l.body AS last_body, l.direction AS last_direction,
      (SELECT count(*)::int FROM ${whatsappMessages} u WHERE u.direction = 'in' AND u.read_at IS NULL AND coalesce(u.customer_id::text, u.wa_id) = coalesce(l.customer_id::text, l.wa_id)) AS unread,
      CASE WHEN l.direction = 'in' THEN (
        SELECT min(i.created_at) FROM ${whatsappMessages} i WHERE i.direction = 'in' AND coalesce(i.customer_id::text, i.wa_id) = coalesce(l.customer_id::text, l.wa_id)
          AND i.created_at > coalesce((SELECT max(o.created_at) FROM ${whatsappMessages} o WHERE o.direction = 'out' AND o.sent_by IS NOT NULL AND coalesce(o.customer_id::text, o.wa_id) = coalesce(l.customer_id::text, l.wa_id)), 'epoch'))
      END AS waiting_since,
      s.name AS specialist
    FROM last l
    LEFT JOIN ${customers} c ON c.id = l.customer_id
    LEFT JOIN ${users} s ON s.id = c.specialist_user_id
    ORDER BY (CASE WHEN l.direction = 'in' THEN 0 ELSE 1 END), waiting_since ASC NULLS LAST, l.created_at DESC
    LIMIT 300`);
  return rows.rows.map((r) => ({
    customerId: r.customer_id,
    waId: r.wa_id,
    name: r.customer_id ? [r.first_name, r.last_name].filter(Boolean).join(" ") : `+${r.wa_id}`,
    lastAt: new Date(r.last_at).toISOString(),
    lastBody: r.last_body.slice(0, 160),
    lastDirection: r.last_direction,
    unread: Number(r.unread),
    waitingSince: r.waiting_since ? new Date(r.waiting_since).toISOString() : null,
    specialist: r.specialist,
  }));
}

// ---------------------------------------------------------------- Webhook (Meta)

/** Handtekening van Meta controleren (X-Hub-Signature-256 = HMAC-SHA256 van de ruwe body met het app secret). */
export function validSignature(appSecret: string, rawBody: string, header: string | undefined) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

interface MetaMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  image?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string };
  audio?: { id: string };
  video?: { id: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}
interface MetaStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  errors?: { title?: string; message?: string; error_data?: { details?: string } }[];
}
export interface MetaWebhook {
  entry?: { changes?: { value?: { messages?: MetaMessage[]; statuses?: MetaStatus[] } }[] }[];
}

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

function describe(m: MetaMessage): { kind: string; body: string; mediaId: string | null } {
  switch (m.type) {
    case "text": return { kind: "text", body: m.text?.body ?? "", mediaId: null };
    case "button": return { kind: "button", body: m.button?.text ?? "", mediaId: null };
    case "interactive": return { kind: "button", body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "", mediaId: null };
    case "image": return { kind: "image", body: m.image?.caption ? `[foto] ${m.image.caption}` : "[foto]", mediaId: m.image?.id ?? null };
    case "document": return { kind: "document", body: `[document] ${m.document?.filename ?? ""} ${m.document?.caption ?? ""}`.trim(), mediaId: m.document?.id ?? null };
    case "audio": return { kind: "audio", body: "[spraakbericht]", mediaId: m.audio?.id ?? null };
    case "video": return { kind: "video", body: m.video?.caption ? `[video] ${m.video.caption}` : "[video]", mediaId: m.video?.id ?? null };
    case "location": return { kind: "location", body: `[locatie] ${m.location?.name ?? ""} ${m.location?.address ?? ""} (${m.location?.latitude}, ${m.location?.longitude})`.trim(), mediaId: null };
    default: return { kind: "other", body: `[${m.type}]`, mediaId: null };
  }
}

/** Klant bij een WhatsApp-nummer; bij meerdere klanten met hetzelfde nummer de nieuwste. */
async function customerForWa(db: DbOrTx, waId: string) {
  const rows = await db
    .select({ id: customers.id, phone: customers.phone, specialist: customers.specialistUserId, firstName: customers.firstName, lastName: customers.lastName })
    .from(customers)
    .where(sql`regexp_replace(coalesce(${customers.phone}, ''), '\\D', '', 'g') = ${waId}`)
    .orderBy(desc(customers.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function handleWebhook(db: Db, deps: WhatsappDeps, payload: MetaWebhook) {
  let received = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      for (const m of v.messages ?? []) {
        const [dup] = await db.select({ id: whatsappMessages.id }).from(whatsappMessages).where(eq(whatsappMessages.providerMessageId, m.id));
        if (dup) continue;
        const c = await customerForWa(db, m.from);
        const d = describe(m);
        await record(db, {
          customerId: c?.id ?? null,
          direction: "in",
          waId: m.from,
          kind: d.kind,
          body: d.body,
          mediaId: d.mediaId,
          status: "received",
          providerMessageId: m.id,
          // Moment van ontvangst (Meta geeft hele seconden; dat verstoort de volgorde met eigen berichten).
          createdAt: new Date(),
        });
        received++;
        // "STOP" = geen WhatsApp-berichten meer (wel nog per e-mail).
        if (c && /^\s*stop\s*$/i.test(d.body)) {
          await db.update(customers).set({ whatsappEnabled: false }).where(eq(customers.id, c.id));
          await deliver(db, deps, { customerId: c.id, waId: m.from }, { text: "U ontvangt van ons geen WhatsApp-berichten meer. Stuur START om ze weer te ontvangen." });
          continue;
        }
        if (c && /^\s*start\s*$/i.test(d.body)) {
          await db.update(customers).set({ whatsappEnabled: true }).where(eq(customers.id, c.id));
        }
        const name = c ? [c.firstName, c.lastName].filter(Boolean).join(" ") : `+${m.from}`;
        const n = { title: `WhatsApp van ${name}`, body: d.body.slice(0, 140), href: c ? `/klanten/${c.id}#whatsapp` : "/whatsapp", dedupeKey: `wa:${m.id}` };
        if (c?.specialist) await notify(db, c.specialist, n);
        else await notifyPermission(db, "specialists.manage", n);
      }
      for (const s of v.statuses ?? []) {
        const [row] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.providerMessageId, s.id));
        if (!row || (RANK[s.status] ?? 0) <= (RANK[row.status] ?? 0)) continue;
        const e = s.errors?.[0];
        await db
          .update(whatsappMessages)
          .set({ status: s.status, error: e ? (e.error_data?.details ?? e.message ?? e.title ?? "mislukt").slice(0, 1000) : row.error })
          .where(eq(whatsappMessages.id, row.id));
      }
    }
  }
  return { received };
}

/** Status voor het beheerscherm: is WhatsApp ingesteld, en welke sjablonen moeten bij Meta bestaan. */
export async function whatsappStatus(db: DbOrTx, config: Config) {
  const company = await getCompany(db);
  const [stats] = await db
    .select({ out: sql<number>`count(*) filter (where direction = 'out')::int`, failed: sql<number>`count(*) filter (where status = 'failed')::int` })
    .from(whatsappMessages)
    .where(gt(whatsappMessages.createdAt, new Date(Date.now() - 7 * 86_400_000)));
  return {
    sending: Boolean(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID),
    receiving: Boolean(config.WHATSAPP_APP_SECRET && config.WHATSAPP_VERIFY_TOKEN),
    webhookUrl: `${config.APP_BASE_URL.replace(/\/$/, "")}/api/public/whatsapp/webhook`,
    language: config.WHATSAPP_TEMPLATE_LANGUAGE,
    company: company.name,
    templates: Object.values(SJABLONEN),
    last7Days: stats ?? { out: 0, failed: 0 },
  };
}
