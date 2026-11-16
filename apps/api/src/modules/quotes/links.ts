import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import type { Config } from "../../config.js";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { AppError, badRequest, conflict } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { button, escapeHtml, layout, type Company } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { organizations } from "../organizations/schema.js";
import { quoteLinkCodes, quoteLinks } from "./schema.js";
import { quoteContentHash } from "./hash.js";
import { acceptQuote, getQuote, redactCosts, type QuoteView } from "./service.js";

const CODE_TTL_MINUTES = 15;
const MAX_CODES_PER_HOUR = 5;
const MAX_ATTEMPTS_PER_CODE = 5;

const euro = (cents: number) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const pct = (bp: number) => `${(bp / 100).toLocaleString("nl-NL")}%`;
const dateNl = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL") : "—");
const fullName = (c: { firstName: string | null; lastName: string }) => [c.firstName, c.lastName].filter(Boolean).join(" ");
const address = (p: QuoteView["property"]) =>
  `${p.street} ${p.houseNumber}${p.houseNumberAddition ? `-${p.houseNumberAddition}` : ""}, ${p.postalCode} ${p.city}`;

export async function getCompany(db: DbOrTx): Promise<Company> {
  const [org] = await db.select().from(organizations).where(eq(organizations.type, "gecko")).limit(1);
  return org ?? { name: "Gecko BV" };
}

/** Publieke weergave: geen kostprijs, marge, interne notitie of interne id's van medewerkers. */
function publicView(q: QuoteView) {
  const r = redactCosts(q);
  return {
    displayNumber: r.displayNumber,
    status: r.effectiveStatus,
    productGroup: r.productGroup.name,
    customerName: fullName(r.customer),
    address: address(r.property),
    priceDate: r.priceDate,
    validUntil: r.validUntil,
    customerNote: r.customerNote,
    advisorName: r.advisor?.name ?? null,
    lines: r.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, unitPriceCents: l.unitPriceCents, vatRateBasisPoints: l.vatRateBasisPoints, lineTotalCents: l.lineTotalCents })),
    totals: r.totals,
    acceptedAt: r.acceptedAt,
    acceptedByName: r.acceptedByName,
  };
}

function quoteTableHtml(q: QuoteView) {
  const rows = q.lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${escapeHtml(l.description)}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${Number(l.quantity).toLocaleString("nl-NL")}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right">${euro(l.lineTotalCents)}</td></tr>`,
    )
    .join("");
  const vat = q.totals.vat.map((v) => `<tr><td colspan="2" style="padding:4px 0;color:#5f6b62">Btw ${pct(v.rateBasisPoints)}</td><td style="text-align:right">${euro(v.vatCents)}</td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0">
<tr><th align="left" style="padding:6px 0;border-bottom:2px solid #dfe3dd">Omschrijving</th><th align="right" style="padding:6px;border-bottom:2px solid #dfe3dd">Aantal</th><th align="right" style="padding:6px 0;border-bottom:2px solid #dfe3dd">Bedrag excl. btw</th></tr>
${rows}
<tr><td colspan="2" style="padding:8px 0 4px">Subtotaal excl. btw</td><td style="text-align:right">${euro(q.totals.subtotalCents)}</td></tr>${vat}
<tr><td colspan="2" style="padding:6px 0;font-weight:bold">Totaal incl. btw</td><td style="text-align:right;font-weight:bold">${euro(q.totals.totalCents)}</td></tr></table>`;
}

function quoteTableText(q: QuoteView) {
  return [
    ...q.lines.map((l) => `- ${l.description} (${Number(l.quantity).toLocaleString("nl-NL")}×): ${euro(l.lineTotalCents)} excl. btw`),
    `Subtotaal excl. btw: ${euro(q.totals.subtotalCents)}`,
    ...q.totals.vat.map((v) => `Btw ${pct(v.rateBasisPoints)}: ${euro(v.vatCents)}`),
    `Totaal incl. btw: ${euro(q.totals.totalCents)}`,
  ].join("\n");
}

const PAYMENT_TERMS = "Betaling: 70% na het inplannen van de schouw, vóór de schouw te voldoen; 30% en eventueel overeengekomen meerwerk na werkende oplevering.";
const WITHDRAWAL =
  "Bedenktijd: u heeft het recht deze overeenkomst binnen 14 dagen na het sluiten zonder opgave van redenen te ontbinden. Dat doet u door ons een e-mail te sturen met uw naam, adres en offertenummer.";

// ---------------------------------------------------------------- Intern: link versturen

export async function sendQuoteLink(
  db: Db,
  transport: EmailTransport | null,
  config: Config,
  actor: ActorContext,
  quoteId: string,
  input: { email?: string | null },
) {
  const q = await getQuote(db, quoteId);
  if (q.effectiveStatus !== "sent") throw conflict("quote_not_sent", "Alleen een definitieve, niet-verlopen offerte kan ter akkoord worden verstuurd");
  const email = (input.email ?? q.customer.email)?.trim().toLowerCase();
  if (!email) throw badRequest("no_email", "Klant heeft geen e-mailadres; vul er een in");

  const token = randomToken();
  const url = `${config.APP_BASE_URL.replace(/\/$/, "")}/akkoord/${token}`;
  const company = await getCompany(db);

  const result = await db.transaction(async (tx) => {
    await tx.update(quoteLinks).set({ revokedAt: new Date() }).where(and(eq(quoteLinks.quoteId, quoteId), isNull(quoteLinks.revokedAt)));
    const [link] = await tx
      .insert(quoteLinks)
      .values({ quoteId, tokenHash: sha256(token), email, createdBy: actor.userId, expiresAt: new Date(`${q.validUntil}T23:59:59+01:00`) })
      .returning();
    await recordAudit(tx, actor, { action: "quote.link_sent", entityType: "quote", entityId: quoteId, metadata: { email } });
    return link!;
  });

  const name = fullName(q.customer);
  const mail = await sendEmail(db, transport, {
    to: email,
    subject: `Uw offerte ${q.displayNumber} van ${company.name}`,
    template: "quote.link",
    customerId: q.customerId,
    related: { type: "quote", id: quoteId },
    html: layout(
      company,
      `<p>Beste ${escapeHtml(name)},</p>
<p>Hierbij ontvangt u onze offerte <strong>${escapeHtml(q.displayNumber)}</strong> voor ${escapeHtml(q.productGroup.name.toLowerCase())} op ${escapeHtml(address(q.property))}.</p>
${quoteTableHtml(q)}
<p>De offerte is geldig tot en met ${dateNl(q.validUntil)}. Via de knop hieronder bekijkt u de volledige offerte en kunt u deze digitaal accepteren.</p>
${button(url, "Offerte bekijken en accepteren")}
<p style="font-size:13px;color:#5f6b62">Deze link is persoonlijk. Stuur deze e-mail niet door.</p>`,
    ),
    text: `Beste ${name},\n\nHierbij ontvangt u onze offerte ${q.displayNumber} voor ${q.productGroup.name.toLowerCase()} op ${address(q.property)}.\n\n${quoteTableText(q)}\n\nGeldig tot en met ${dateNl(q.validUntil)}.\nBekijken en accepteren: ${url}\n\nDeze link is persoonlijk. Stuur deze e-mail niet door.\n\n${company.name}`,
  });

  // Zonder e-mailkoppeling krijgt de medewerker de link te zien, om zelf te delen of te testen.
  return { linkId: result.id, email, emailStatus: mail.status, emailError: mail.error, url: mail.status === "sent" ? null : url };
}

/**
 * Akkoordlink voor het klantportaal: de klant is daar al via een e-maillink ingelogd en gaat direct naar de
 * akkoordpagina (die voor het akkoord nog steeds een code per e-mail vraagt). Bestaande links blijven geldig.
 */
export async function issuePortalQuoteLink(db: Db, quoteId: string, email: string) {
  const q = await getQuote(db, quoteId);
  if (q.effectiveStatus !== "sent") throw conflict("quote_not_sent", "Deze offerte kan niet (meer) worden geaccepteerd");
  const token = randomToken();
  await db.insert(quoteLinks).values({ quoteId, tokenHash: sha256(token), email, createdBy: null, expiresAt: new Date(`${q.validUntil}T23:59:59+01:00`) });
  await recordAudit(db, { userId: null, organizationId: null, permissions: new Set() }, { action: "quote.link_portal", entityType: "quote", entityId: quoteId, metadata: { email } });
  return token;
}

// ---------------------------------------------------------------- Publiek: bekijken, code, akkoord

async function resolveLink(db: DbOrTx, token: string) {
  const [link] = await db.select().from(quoteLinks).where(eq(quoteLinks.tokenHash, sha256(token)));
  if (!link || link.revokedAt) throw new AppError(404, "link_invalid", "Deze link is niet (meer) geldig. Neem contact met ons op voor een nieuwe link.");
  return link;
}

const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, c: string) => `${a}${"•".repeat(Math.min(b.length, 6))}${c}`);

export async function viewByToken(db: Db, token: string) {
  const link = await resolveLink(db, token);
  await db.update(quoteLinks).set({ lastViewedAt: new Date() }).where(eq(quoteLinks.id, link.id));
  const q = await getQuote(db, link.quoteId);
  const company = await getCompany(db);
  const linkExpired = link.expiresAt < new Date();
  return {
    quote: publicView(q),
    email: maskEmail(link.email),
    canAccept: q.effectiveStatus === "sent" && !linkExpired,
    company: { name: company.name, email: company.email ?? null, phone: company.phone ?? null },
    paymentTerms: PAYMENT_TERMS,
    withdrawal: WITHDRAWAL,
  };
}

export async function requestCode(db: Db, transport: EmailTransport | null, token: string) {
  const link = await resolveLink(db, token);
  const q = await getQuote(db, link.quoteId);
  if (q.effectiveStatus !== "sent" || link.expiresAt < new Date()) throw conflict("cannot_accept", "Deze offerte kan niet meer worden geaccepteerd");
  const hourAgo = new Date(Date.now() - 3600_000);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(quoteLinkCodes)
    .where(and(eq(quoteLinkCodes.linkId, link.id), gt(quoteLinkCodes.createdAt, hourAgo)));
  if (n >= MAX_CODES_PER_HOUR) throw new AppError(429, "too_many_codes", "Te veel codes aangevraagd. Probeer het over een uur opnieuw.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(quoteLinkCodes).values({ linkId: link.id, codeHash: sha256(`${link.id}:${code}`), expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000) });
  const company = await getCompany(db);
  const mail = await sendEmail(db, transport, {
    to: link.email,
    subject: `Uw code: ${code}`,
    template: "quote.code",
    customerId: q.customerId,
    related: { type: "quote", id: q.id },
    html: layout(
      company,
      `<p>Uw code om offerte ${escapeHtml(q.displayNumber)} te accepteren:</p><p style="font-size:30px;font-weight:bold;letter-spacing:6px">${code}</p><p style="font-size:13px;color:#5f6b62">De code is ${CODE_TTL_MINUTES} minuten geldig. Heeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.</p>`,
    ),
    text: `Uw code om offerte ${q.displayNumber} te accepteren: ${code}\nDe code is ${CODE_TTL_MINUTES} minuten geldig.`,
  });
  if (mail.status === "failed") throw new AppError(502, "email_failed", "De code kon niet worden verstuurd. Probeer het later opnieuw.");
  return { sentTo: maskEmail(link.email), expiresInMinutes: CODE_TTL_MINUTES };
}

export async function acceptByToken(
  db: Db,
  transport: EmailTransport | null,
  token: string,
  input: { code: string; name: string; agreeTerms: boolean },
  meta: { ip?: string; userAgent?: string; requestId?: string },
) {
  if (!input.agreeTerms) throw badRequest("terms_required", "Ga akkoord met de offerte en de voorwaarden");
  const link = await resolveLink(db, token);
  if (link.expiresAt < new Date()) throw conflict("cannot_accept", "Deze offerte kan niet meer worden geaccepteerd");

  // Code controleren: alleen de nieuwste, ongebruikte, niet-verlopen code; beperkt aantal pogingen.
  const [code] = await db
    .select()
    .from(quoteLinkCodes)
    .where(and(eq(quoteLinkCodes.linkId, link.id), isNull(quoteLinkCodes.usedAt), gt(quoteLinkCodes.expiresAt, new Date())))
    .orderBy(desc(quoteLinkCodes.createdAt))
    .limit(1);
  if (!code) throw badRequest("code_expired", "Vraag eerst een (nieuwe) code aan");
  if (code.attempts >= MAX_ATTEMPTS_PER_CODE) throw badRequest("code_locked", "Te veel onjuiste pogingen. Vraag een nieuwe code aan.");
  if (code.codeHash !== sha256(`${link.id}:${input.code.trim()}`)) {
    await db.update(quoteLinkCodes).set({ attempts: code.attempts + 1 }).where(eq(quoteLinkCodes.id, code.id));
    throw badRequest("invalid_code", "Code onjuist");
  }
  await db.update(quoteLinkCodes).set({ usedAt: new Date() }).where(eq(quoteLinkCodes.id, code.id));

  const before = await getQuote(db, link.quoteId);
  const hash = quoteContentHash(before);
  if (before.contentHash && before.contentHash !== hash) {
    throw conflict("quote_changed", "De offerte is gewijzigd sinds deze is verstuurd. Neem contact met ons op.");
  }
  const actor: ActorContext = { userId: null, organizationId: null, permissions: new Set(), ip: meta.ip, requestId: meta.requestId };
  const acceptedAt = new Date();
  const accepted = await acceptQuote(db, actor, link.quoteId, {
    acceptedByName: input.name.trim(),
    method: "signed_digital",
    acceptedAt,
    evidence: {
      channel: "email_link",
      email: link.email,
      linkId: link.id,
      codeVerified: true,
      codeCreatedAt: code.createdAt.toISOString(),
      acceptedAt: acceptedAt.toISOString(),
      typedName: input.name.trim(),
      termsAccepted: true,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      contentHash: hash,
    },
  });
  await db.update(quoteLinks).set({ revokedAt: new Date() }).where(eq(quoteLinks.id, link.id));

  // Bevestiging met volledige inhoud: geldt als vastlegging op een duurzame gegevensdrager.
  const company = await getCompany(db);
  await sendEmail(db, transport, {
    to: link.email,
    subject: `Bevestiging: u heeft offerte ${accepted.displayNumber} geaccepteerd`,
    template: "quote.accepted",
    customerId: accepted.customerId,
    related: { type: "quote", id: accepted.id },
    html: layout(
      company,
      `<p>Beste ${escapeHtml(fullName(accepted.customer))},</p>
<p>Bedankt! U heeft op ${acceptedAt.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })} offerte <strong>${escapeHtml(accepted.displayNumber)}</strong> geaccepteerd voor ${escapeHtml(accepted.productGroup.name.toLowerCase())} op ${escapeHtml(address(accepted.property))}.</p>
${quoteTableHtml(accepted)}
<p>${escapeHtml(PAYMENT_TERMS)}</p>
<p>${escapeHtml(WITHDRAWAL)}</p>
<p>Wij nemen binnenkort contact met u op over de volgende stappen.</p>
<p style="font-size:12px;color:#5f6b62">Kenmerk akkoord: ${hash.slice(0, 16)}</p>`,
    ),
    text: `Beste ${fullName(accepted.customer)},\n\nU heeft offerte ${accepted.displayNumber} geaccepteerd.\n\n${quoteTableText(accepted)}\n\n${PAYMENT_TERMS}\n\n${WITHDRAWAL}\n\nKenmerk akkoord: ${hash.slice(0, 16)}\n\n${company.name}`,
  });

  return { status: "accepted" as const, displayNumber: accepted.displayNumber };
}

