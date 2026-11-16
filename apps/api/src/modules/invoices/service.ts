import { and, asc, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { todayIso } from "../../lib/dates.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { multiplyCents } from "../../lib/money.js";
import { recordAudit } from "../audit/service.js";
import { products } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { formatCustomerNumber } from "../customers/service.js";
import { button, escapeHtml, layout, type Company } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { emitEvent } from "../events/service.js";
import { projects } from "../projects/schema.js";
import { getCompany } from "../quotes/links.js";
import { quoteLines, quotes } from "../quotes/schema.js";
import { calculateTotals } from "../quotes/service.js";
import { getSetting } from "../settings/service.js";
import { nextSurveyDate } from "../planning/service.js";
import type { PaymentProvider } from "./payments-provider.js";
import { invoiceLines, invoiceNumberSequences, invoices, payments, type Invoice } from "./schema.js";

export interface BillingDeps {
  config: Config;
  emailTransport: EmailTransport | null;
  paymentProvider: PaymentProvider;
}

const SERIES = "F";
const TYPE_LABEL = { deposit: "Aanbetaling", final: "Eindfactuur", credit: "Creditnota" } as const;
const euro = (cents: number) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const dateNl = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL") : "—");
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const baseUrl = (config: Config) => config.APP_BASE_URL.replace(/\/$/, "");

// ---------------------------------------------------------------- Lezen

export async function getInvoice(db: DbOrTx, id: string) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) throw notFound("Factuur");
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.sortOrder));
  const pays = await db.select().from(payments).where(eq(payments.invoiceId, id)).orderBy(desc(payments.createdAt));
  const [customer] = await db.select().from(customers).where(eq(customers.id, inv.customerId));
  return {
    ...inv,
    publicTokenHash: undefined,
    outstandingCents: inv.status === "open" ? inv.totalCents - inv.paidCents : 0,
    lines,
    payments: pays,
    customer: customer ? { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email, displayNumber: formatCustomerNumber(customer.number) } : null,
  };
}

export type InvoiceView = Awaited<ReturnType<typeof getInvoice>>;

export async function listInvoices(
  db: DbOrTx,
  q: { status?: Invoice["status"]; customerId?: string; projectId?: string; overdue?: boolean; limit: number; offset: number },
) {
  const filters: SQL[] = [];
  if (q.status) filters.push(eq(invoices.status, q.status));
  if (q.customerId) filters.push(eq(invoices.customerId, q.customerId));
  if (q.projectId) filters.push(eq(invoices.projectId, q.projectId));
  if (q.overdue) filters.push(eq(invoices.status, "open"), sql`${invoices.dueDate} < ${todayIso()}`);
  const rows = await db
    .select({ invoice: invoices, customer: customers })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(invoices.createdAt))
    .limit(q.limit)
    .offset(q.offset);
  return rows.map((r) => ({
    ...r.invoice,
    publicTokenHash: undefined,
    outstandingCents: r.invoice.status === "open" ? r.invoice.totalCents - r.invoice.paidCents : 0,
    customer: { id: r.customer.id, firstName: r.customer.firstName, lastName: r.customer.lastName, displayNumber: formatCustomerNumber(r.customer.number) },
  }));
}

// ---------------------------------------------------------------- Opbouwen

type NewLine = Omit<typeof invoiceLines.$inferInsert, "invoiceId" | "id">;

/**
 * Maakt de aanbetalings- of eindfactuur voor een project op basis van de geaccepteerde offerte.
 * Idempotent: bestaat er al een (niet-gecrediteerde) factuur van dit type, dan wordt die teruggegeven.
 */
export async function createInvoiceForProject(db: Db, actor: ActorContext, projectId: string, type: "deposit" | "final") {
  return db.transaction(async (tx) => {
    // Vergrendel het project zodat twee gelijktijdige triggers niet twee facturen maken.
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFound("Project");
    const [existing] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.projectId, projectId), eq(invoices.type, type), ne(invoices.status, "credited")));
    if (existing) return { invoiceId: existing.id, created: false };

    const [quote] = await tx.select().from(quotes).where(and(eq(quotes.projectId, projectId), eq(quotes.status, "accepted"), eq(quotes.kind, "main")));
    if (!quote) throw badRequest("no_accepted_quote", "Dit project heeft geen geaccepteerde offerte om te factureren");
    const qLines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(asc(quoteLines.sortOrder));
    const quoteNumber = `O-${String(quote.number).padStart(6, "0")}`;

    let lines: NewLine[];
    if (type === "deposit") {
      const bp = await getSetting(tx, "invoice.deposit_basis_points");
      const pct = (bp / 100).toLocaleString("nl-NL");
      lines = qLines.map((l, i) => {
        const total = Math.round((multiplyCents(l.unitPriceCents, l.quantity) * bp) / 10000);
        return {
          productId: l.productId,
          productCode: null,
          description: `Aanbetaling ${pct}% — ${l.description} (offerte ${quoteNumber})`,
          quantity: "1",
          unitPriceCents: total,
          vatRateBasisPoints: l.vatRateBasisPoints,
          lineTotalCents: total,
          sortOrder: (i + 1) * 10,
        };
      });
    } else {
      lines = qLines.map((l, i) => ({
        productId: l.productId,
        productCode: null,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        vatRateBasisPoints: l.vatRateBasisPoints,
        lineTotalCents: multiplyCents(l.unitPriceCents, l.quantity),
        sortOrder: (i + 1) * 10,
      }));
      // Geaccepteerd meerwerk (uit de schouw) komt erbij.
      const extra = await tx.select().from(quotes).where(and(eq(quotes.projectId, projectId), eq(quotes.status, "accepted"), eq(quotes.kind, "extra_work")));
      for (const eq_ of extra) {
        const xl = await tx.select().from(quoteLines).where(eq(quoteLines.quoteId, eq_.id)).orderBy(asc(quoteLines.sortOrder));
        const xNumber = `O-${String(eq_.number).padStart(6, "0")}`;
        xl.forEach((l, i) =>
          lines.push({
            productId: l.productId,
            productCode: null,
            description: `Meerwerk: ${l.description} (offerte ${xNumber})`,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            vatRateBasisPoints: l.vatRateBasisPoints,
            lineTotalCents: multiplyCents(l.unitPriceCents, l.quantity),
            sortOrder: 500 + i,
          }),
        );
      }
      // Reeds gefactureerde aanbetaling in mindering, per btw-tarief.
      const [deposit] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.projectId, projectId), eq(invoices.type, "deposit"), ne(invoices.status, "credited")));
      if (deposit) {
        if (!deposit.number) throw conflict("deposit_not_final", "De aanbetalingsfactuur is nog niet definitief");
        const depLines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, deposit.id));
        const byRate = new Map<number, number>();
        for (const d of depLines) byRate.set(d.vatRateBasisPoints, (byRate.get(d.vatRateBasisPoints) ?? 0) + d.lineTotalCents);
        let i = 900;
        for (const [rate, amount] of byRate) {
          lines.push({
            productId: null,
            productCode: null,
            description: `Reeds gefactureerd: aanbetaling ${deposit.number} (btw ${(rate / 100).toLocaleString("nl-NL")}%)`,
            quantity: "1",
            unitPriceCents: -amount,
            vatRateBasisPoints: rate,
            lineTotalCents: -amount,
            sortOrder: i++,
          });
        }
      }
    }
    // Productcodes van de catalogus meenemen, zodat facturen dezelfde codes gebruiken als offertes.
    const productIds = [...new Set(lines.map((l) => l.productId).filter((x): x is string => !!x))];
    if (productIds.length) {
      const codes = await tx.select({ id: products.id, code: products.code }).from(products).where(inArray(products.id, productIds));
      const map = new Map(codes.map((r) => [r.id, r.code]));
      for (const l of lines) if (l.productId) l.productCode = map.get(l.productId) ?? null;
    }

    const [inv] = await tx
      .insert(invoices)
      .values({ type, customerId: project.customerId, projectId, quoteId: quote.id, createdBy: actor.userId })
      .returning();
    if (lines.length) await tx.insert(invoiceLines).values(lines.map((l) => ({ ...l, invoiceId: inv!.id })));
    await recordAudit(tx, actor, { action: "invoice.created", entityType: "invoice", entityId: inv!.id, after: { type, projectId } });
    await finalizeInTx(tx, actor, inv!.id);
    return { invoiceId: inv!.id, created: true };
  });
}

/** Definitief maken: nummer toekennen, bedragen en gegevens vastleggen. Daarna onveranderbaar. */
async function finalizeInTx(tx: DbOrTx, actor: ActorContext, invoiceId: string) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!inv) throw notFound("Factuur");
  if (inv.number) throw conflict("invoice_final", "Factuur is al definitief");
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  if (!lines.length) throw badRequest("invoice_empty", "Factuur heeft geen regels");
  const totals = calculateTotals(lines);

  const today = todayIso();
  const year = Number(today.slice(0, 4));
  // Gapless nummering: de teller wordt binnen dezelfde transactie opgehoogd en vergrendeld.
  const [seq] = await tx
    .insert(invoiceNumberSequences)
    .values({ series: SERIES, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [invoiceNumberSequences.series, invoiceNumberSequences.year],
      set: { lastNumber: sql`${invoiceNumberSequences.lastNumber} + 1` },
    })
    .returning();
  const number = `${SERIES}${year}-${String(seq!.lastNumber).padStart(6, "0")}`;

  const [customer] = await tx.select().from(customers).where(eq(customers.id, inv.customerId));
  let address = null;
  if (inv.projectId) {
    const [row] = await tx
      .select({ property: properties })
      .from(projects)
      .innerJoin(properties, eq(properties.id, projects.propertyId))
      .where(eq(projects.id, inv.projectId));
    address = row?.property ?? null;
  }
  const company = await getCompany(tx);
  const term = await getSetting(tx, "invoice.payment_term_days");
  let dueDate = inv.type === "credit" ? today : addDays(today, term);
  if (inv.type === "deposit" && inv.projectId) {
    // Aanbetaling moet binnen zijn vóór de schouw: vervaldatum uiterlijk X dagen vóór de schouwdatum (maar niet vóór morgen).
    const survey = await nextSurveyDate(tx, inv.projectId);
    if (survey) {
      const before = await getSetting(tx, "invoice.deposit_due_days_before_survey");
      const latest = addDays(survey, -before);
      const earliest = addDays(today, 1);
      if (latest < dueDate) dueDate = latest < earliest ? earliest : latest;
    }
  }
  const token = randomToken();

  await tx
    .update(invoices)
    .set({
      number,
      status: totals.totalCents <= 0 && inv.type === "credit" ? "paid" : "open",
      invoiceDate: today,
      dueDate,
      subtotalCents: totals.subtotalCents,
      vatCents: totals.vatCents,
      totalCents: totals.totalCents,
      vatBreakdown: totals.vat,
      paymentReference: number.replace(/\D/g, ""),
      customerSnapshot: {
        name: [customer!.firstName, customer!.lastName].filter(Boolean).join(" "),
        customerNumber: formatCustomerNumber(customer!.number),
        email: customer!.email,
        address: address
          ? { street: address.street, houseNumber: address.houseNumber, houseNumberAddition: address.houseNumberAddition, postalCode: address.postalCode, city: address.city }
          : null,
      },
      companySnapshot: company,
      publicTokenHash: sha256(token),
      finalizedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId));
  await recordAudit(tx, actor, { action: "invoice.finalized", entityType: "invoice", entityId: invoiceId, after: { number, totalCents: totals.totalCents } });
  return { number, token };
}

// ---------------------------------------------------------------- Versturen

/** Nieuwe link voor de openbare factuurpagina (oude link vervalt) en e-mail naar de klant. */
export async function sendInvoice(db: Db, deps: BillingDeps, actor: ActorContext, invoiceId: string) {
  const inv = await getInvoice(db, invoiceId);
  if (!inv.number) throw conflict("invoice_not_final", "Factuur is nog niet definitief");
  const email = (inv.customerSnapshot as { email?: string } | null)?.email;
  if (!email) throw badRequest("no_email", "Klant heeft geen e-mailadres");
  const token = randomToken();
  // Alleen de token-hash wijzigen is toegestaan op een definitieve factuur.
  await db.update(invoices).set({ publicTokenHash: sha256(token), sentAt: new Date() }).where(eq(invoices.id, invoiceId));
  const url = `${baseUrl(deps.config)}/factuur/${token}`;
  const company = (inv.companySnapshot as Company) ?? (await getCompany(db));
  const snap = inv.customerSnapshot as { name: string };
  const isCredit = inv.type === "credit";
  const mail = await sendEmail(db, deps.emailTransport, {
    to: email,
    subject: `${TYPE_LABEL[inv.type]} ${inv.number} van ${company.name}`,
    template: `invoice.${inv.type}`,
    customerId: inv.customerId,
    related: { type: "invoice", id: inv.id },
    html: layout(
      company,
      `<p>Beste ${escapeHtml(snap.name)},</p>
<p>Hierbij ontvangt u ${isCredit ? "creditnota" : "factuur"} <strong>${escapeHtml(inv.number)}</strong> (${TYPE_LABEL[inv.type].toLowerCase()}) van ${euro(inv.totalCents)} incl. btw.</p>
${isCredit ? "" : `<p>Wij verzoeken u het bedrag uiterlijk <strong>${dateNl(inv.dueDate)}</strong> te voldoen. Dat kan het snelst via iDEAL met de knop hieronder.</p>${button(url, "Factuur bekijken en betalen")}<p style="font-size:13px;color:#5f6b62">Liever overmaken? Gebruik IBAN ${escapeHtml((company as { iban?: string }).iban ?? "")} t.n.v. ${escapeHtml(company.name)} onder vermelding van <strong>${escapeHtml(inv.paymentReference ?? inv.number)}</strong>.</p>`}
${isCredit ? button(url, "Creditnota bekijken") : ""}`,
    ),
    text: `Beste ${snap.name},\n\n${TYPE_LABEL[inv.type]} ${inv.number}: ${euro(inv.totalCents)} incl. btw.\n${isCredit ? "" : `Uiterlijk te betalen op ${dateNl(inv.dueDate)}.\n`}Bekijken${isCredit ? "" : " en betalen"}: ${url}\n\n${company.name}`,
  });
  await recordAudit(db, actor, { action: "invoice.sent", entityType: "invoice", entityId: invoiceId, metadata: { email, emailStatus: mail.status } });
  await emitEvent(db, "invoice.sent", { type: "invoice", id: invoiceId }, { invoiceId });
  return { email, emailStatus: mail.status, emailError: mail.error, url: mail.status === "sent" ? null : url };
}

/** Automatisering: factuur maken en direct versturen (bij het bereiken van een status in de klantreis). */
export async function invoiceProjectAndSend(db: Db, deps: BillingDeps, actor: ActorContext, projectId: string, type: "deposit" | "final") {
  const { invoiceId, created } = await createInvoiceForProject(db, actor, projectId, type);
  if (created) await sendInvoice(db, deps, actor, invoiceId);
  return invoiceId;
}

// ---------------------------------------------------------------- Betalingen

async function applyPaidAmount(tx: DbOrTx, actor: ActorContext, invoiceId: string) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  const [{ paid } = { paid: 0 }] = await tx
    .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)::bigint` })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "paid")));
  const paidCents = Number(paid);
  const fullyPaid = paidCents >= inv!.totalCents && inv!.status === "open";
  await tx
    .update(invoices)
    .set({ paidCents, ...(fullyPaid ? { status: "paid" as const, paidAt: new Date() } : {}) })
    .where(eq(invoices.id, invoiceId));
  if (fullyPaid) {
    await recordAudit(tx, actor, { action: "invoice.paid", entityType: "invoice", entityId: invoiceId, after: { paidCents } });
    await emitEvent(tx, "invoice.paid", { type: "invoice", id: invoiceId }, { invoiceId, projectId: inv!.projectId, type: inv!.type });
  }
}

/** Handmatig een betaling registreren (overschrijving, Warmtefonds). */
export async function registerPayment(
  db: Db,
  actor: ActorContext,
  invoiceId: string,
  input: { amountCents: number; method: "bank_transfer" | "warmtefonds" | "other"; paidAt?: Date; note?: string | null },
) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!inv) throw notFound("Factuur");
    if (inv.status !== "open") throw conflict("invoice_not_open", "Alleen een openstaande factuur kan een betaling krijgen");
    const [p] = await tx
      .insert(payments)
      .values({ invoiceId, amountCents: input.amountCents, method: input.method, status: "paid", paidAt: input.paidAt ?? new Date(), note: input.note ?? null, registeredBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, { action: "payment.registered", entityType: "invoice", entityId: invoiceId, after: { amountCents: p!.amountCents, method: p!.method } });
    await applyPaidAmount(tx, actor, invoiceId);
    return getInvoice(tx, invoiceId);
  });
}

async function findByToken(db: DbOrTx, token: string) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.publicTokenHash, sha256(token)));
  if (!inv) throw new AppError(404, "link_invalid", "Deze link is niet (meer) geldig. Neem contact met ons op.");
  return inv;
}

export async function publicInvoice(db: DbOrTx, token: string) {
  const inv = await findByToken(db, token);
  const full = await getInvoice(db, inv.id);
  return {
    number: full.number,
    type: full.type,
    status: full.status,
    invoiceDate: full.invoiceDate,
    dueDate: full.dueDate,
    customer: full.customerSnapshot,
    company: full.companySnapshot,
    lines: full.lines.map((l) => ({ description: l.description, productCode: l.productCode, quantity: l.quantity, unitPriceCents: l.unitPriceCents, vatRateBasisPoints: l.vatRateBasisPoints, lineTotalCents: l.lineTotalCents })),
    subtotalCents: full.subtotalCents,
    vatBreakdown: full.vatBreakdown,
    totalCents: full.totalCents,
    paidCents: full.paidCents,
    outstandingCents: full.outstandingCents,
    paymentReference: full.paymentReference,
  };
}

/** Klant klikt op "Betalen": betaalverzoek voor het openstaande bedrag bij de provider. */
export async function startOnlinePayment(db: Db, deps: BillingDeps, token: string) {
  const inv = await findByToken(db, token);
  if (inv.status !== "open") throw conflict("invoice_not_open", "Deze factuur staat niet meer open");
  const outstanding = inv.totalCents - inv.paidCents;
  if (outstanding <= 0) throw conflict("nothing_to_pay", "Er staat niets meer open");
  const [p] = await db.insert(payments).values({ invoiceId: inv.id, amountCents: outstanding, method: "online", status: "pending", provider: deps.paymentProvider.name }).returning();
  const base = baseUrl(deps.config);
  try {
    const res = await deps.paymentProvider.createPayment(
      {
        amountCents: outstanding,
        description: `Factuur ${inv.number}`,
        redirectUrl: `${base}/factuur/${token}?betaald=1`,
        webhookUrl: `${base}/api/public/payments/${deps.paymentProvider.name}/webhook`,
        metadata: { invoiceId: inv.id, paymentId: p!.id },
      },
      p!.id,
    );
    await db.update(payments).set({ providerPaymentId: res.providerPaymentId, checkoutUrl: res.checkoutUrl }).where(eq(payments.id, p!.id));
    return { checkoutUrl: res.checkoutUrl };
  } catch (err) {
    await db.update(payments).set({ status: "failed", note: err instanceof Error ? err.message.slice(0, 500) : String(err) }).where(eq(payments.id, p!.id));
    throw new AppError(502, "payment_provider_error", "Betalen is op dit moment niet mogelijk. Probeer het later opnieuw of maak het bedrag over.");
  }
}

/** Webhook van de provider: status altijd opnieuw bij de provider ophalen (nooit de webhook-inhoud vertrouwen). */
export async function handleProviderWebhook(db: Db, deps: BillingDeps, providerPaymentId: string) {
  const [p] = await db.select().from(payments).where(and(eq(payments.provider, deps.paymentProvider.name), eq(payments.providerPaymentId, providerPaymentId)));
  if (!p) return; // onbekend: negeren (Mollie verwacht toch 200)
  const status = await deps.paymentProvider.getStatus(providerPaymentId);
  if (!status) return;
  await settlePayment(db, p.id, status.status, status.paidAt);
}

/** Verwerkt een definitieve status van een online betaling. Idempotent. */
export async function settlePayment(db: Db, paymentId: string, status: "pending" | "paid" | "failed" | "expired" | "canceled", paidAt: Date | null) {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p || p.status === "paid" || p.status === status) return;
    await tx.update(payments).set({ status, paidAt: status === "paid" ? (paidAt ?? new Date()) : null }).where(eq(payments.id, paymentId));
    const actor: ActorContext = { userId: null, organizationId: null, permissions: new Set() };
    await recordAudit(tx, actor, { action: `payment.${status}`, entityType: "invoice", entityId: p.invoiceId, after: { amountCents: p.amountCents, provider: p.provider } });
    if (status === "paid") await applyPaidAmount(tx, actor, p.invoiceId);
  });
}

/** Alleen voor testmodus: de gesimuleerde betaalpagina. */
export async function testPaymentInfo(db: DbOrTx, paymentId: string) {
  const [p] = await db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.provider, "test")));
  if (!p) throw notFound("Testbetaling");
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, p.invoiceId));
  return { amountCents: p.amountCents, status: p.status, invoiceNumber: inv!.number };
}

// ---------------------------------------------------------------- Creditnota

export async function creditInvoice(db: Db, actor: ActorContext, invoiceId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [orig] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!orig) throw notFound("Factuur");
    if (orig.type === "credit") throw badRequest("cannot_credit_credit", "Een creditnota kan niet worden gecrediteerd");
    if (!orig.number || (orig.status !== "open" && orig.status !== "paid")) throw conflict("invoice_not_creditable", "Deze factuur kan niet worden gecrediteerd");
    const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    const [credit] = await tx
      .insert(invoices)
      .values({ type: "credit", customerId: orig.customerId, projectId: orig.projectId, quoteId: orig.quoteId, creditedInvoiceId: orig.id, note: reason, createdBy: actor.userId })
      .returning();
    await tx.insert(invoiceLines).values(
      lines.map((l) => ({
        invoiceId: credit!.id,
        productId: l.productId,
        productCode: l.productCode,
        description: `Creditering ${orig.number}: ${l.description}`,
        quantity: l.quantity,
        unitPriceCents: -l.unitPriceCents,
        vatRateBasisPoints: l.vatRateBasisPoints,
        lineTotalCents: -l.lineTotalCents,
        sortOrder: l.sortOrder,
      })),
    );
    await finalizeInTx(tx, actor, credit!.id);
    await tx.update(invoices).set({ status: "credited" }).where(eq(invoices.id, orig.id));
    await recordAudit(tx, actor, {
      action: "invoice.credited",
      entityType: "invoice",
      entityId: orig.id,
      metadata: { creditInvoiceId: credit!.id, reason, alreadyPaidCents: orig.paidCents },
    });
    return getInvoice(tx, credit!.id);
  });
}

// ---------------------------------------------------------------- Aanmaningen pauzeren

export async function setDunningPause(db: Db, actor: ActorContext, invoiceId: string, reason: string | null) {
  const [before] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!before) throw notFound("Factuur");
  await db.update(invoices).set({ dunningPaused: reason }).where(eq(invoices.id, invoiceId));
  await recordAudit(db, actor, { action: reason ? "dunning.paused" : "dunning.resumed", entityType: "invoice", entityId: invoiceId, metadata: reason ? { reason } : undefined });
  return getInvoice(db, invoiceId);
}

// ---------------------------------------------------------------- Export voor Exact

/** CSV met één regel per factuur per btw-tarief, voor import in Exact (tot de API-koppeling er is). */
export async function exportCsv(db: DbOrTx, from: string, to: string) {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(gte(invoices.invoiceDate, from), lte(invoices.invoiceDate, to), inArray(invoices.status, ["open", "paid", "credited"])))
    .orderBy(asc(invoices.number));
  const head = ["Factuurnummer", "Factuurdatum", "Vervaldatum", "Soort", "Klantnummer", "Klantnaam", "Btw-tarief", "Omzet excl. btw", "Btw", "Totaal factuur incl. btw", "Betalingskenmerk"];
  const fmt = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out = [head.join(";")];
  for (const inv of rows) {
    const snap = inv.customerSnapshot as { name: string; customerNumber: string };
    for (const v of inv.vatBreakdown as { rateBasisPoints: number; baseCents: number; vatCents: number }[]) {
      out.push(
        [inv.number!, inv.invoiceDate!, inv.dueDate!, TYPE_LABEL[inv.type], snap.customerNumber, snap.name, `${v.rateBasisPoints / 100}%`, fmt(v.baseCents), fmt(v.vatCents), fmt(inv.totalCents), inv.paymentReference ?? ""]
          .map((x) => esc(String(x)))
          .join(";"),
      );
    }
  }
  return `﻿${out.join("\r\n")}\r\n`;
}
