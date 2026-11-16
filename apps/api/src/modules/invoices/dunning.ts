import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { todayIso } from "../../lib/dates.js";
import { recordAudit } from "../audit/service.js";
import { button, escapeHtml, layout, type Company } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import { emitEvent } from "../events/service.js";
import { getSetting } from "../settings/service.js";
import { dunningEvents, invoices, type Invoice } from "./schema.js";
import type { BillingDeps } from "./service.js";
import { wikCollectionCosts } from "./wik.js";

const euro = (cents: number) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const dateNl = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL");
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const system: ActorContext = { userId: null, organizationId: null, permissions: new Set() };

/**
 * Aanmaanflow voor consumenten (WIK):
 *   1. herinnering            — na de vervaldatum, vriendelijk, betalen binnen X dagen
 *   2. 14-dagenbrief          — wettelijk verplicht vóór incassokosten; noemt de kosten als niet binnen 14 dagen betaald
 *   3. overdracht incasso     — na verstrijken van de 14-dagenbrief; gebeurtenis voor opvolging (geen mail aan klant)
 * Idempotent: elke stap gebeurt hooguit één keer per factuur. Gepauzeerde facturen worden overgeslagen.
 */
export async function runDunning(db: Db, deps: BillingDeps, today = todayIso()) {
  if (!(await getSetting(db, "dunning.enabled"))) return { processed: 0 };
  const reminderAfter = await getSetting(db, "dunning.reminder_days_after_due");
  const reminderTerm = await getSetting(db, "dunning.reminder_term_days");
  const formalTerm = await getSetting(db, "dunning.formal_term_days");
  const collectionAfter = await getSetting(db, "dunning.collection_after_days");

  const open = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.status, "open"), isNull(invoices.dunningPaused), sql`${invoices.dueDate} < ${today}`, sql`${invoices.type} <> 'credit'`));
  let processed = 0;
  for (const inv of open) {
    const [last] = await db.select().from(dunningEvents).where(eq(dunningEvents.invoiceId, inv.id)).orderBy(desc(dunningEvents.createdAt)).limit(1);
    const outstanding = inv.totalCents - inv.paidCents;
    if (outstanding <= 0) continue;
    try {
      if (inv.dunningStage === "none" && today >= addDays(inv.dueDate!, reminderAfter)) {
        await sendDunning(db, deps, inv, "reminder", outstanding, addDays(today, reminderTerm), null);
        processed++;
      } else if (inv.dunningStage === "reminder" && last?.deadline && today > last.deadline) {
        // +1: de termijn gaat in op de dag ná ontvangst van de brief.
        await sendDunning(db, deps, inv, "formal_notice", outstanding, addDays(today, formalTerm + 1), wikCollectionCosts(outstanding));
        processed++;
      } else if (inv.dunningStage === "formal_notice" && last?.deadline && today >= addDays(last.deadline, collectionAfter)) {
        await db.transaction(async (tx) => {
          await tx.update(invoices).set({ dunningStage: "collection", dunningStageAt: new Date() }).where(eq(invoices.id, inv.id));
          await tx.insert(dunningEvents).values({ invoiceId: inv.id, stage: "collection", outstandingCents: outstanding, collectionCostsCents: wikCollectionCosts(outstanding) });
          await recordAudit(tx, system, { action: "dunning.collection", entityType: "invoice", entityId: inv.id, metadata: { outstandingCents: outstanding } });
          await emitEvent(tx, "invoice.collection", { type: "invoice", id: inv.id }, { invoiceId: inv.id, outstandingCents: outstanding });
        });
        processed++;
      }
    } catch (err) {
      console.error(JSON.stringify({ level: 50, msg: "dunning_failed", invoiceId: inv.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return { processed };
}

async function sendDunning(
  db: Db,
  deps: BillingDeps,
  inv: Invoice,
  stage: "reminder" | "formal_notice",
  outstanding: number,
  deadline: string,
  costs: number | null,
) {
  // Verse betaallink (de oude kan zijn verlopen of verloren).
  const { url } = await sendInvoiceLinkOnly(db, deps, inv.id);
  const company = inv.companySnapshot as Company;
  const snap = inv.customerSnapshot as { name: string; email: string | null };
  if (!snap.email) return;
  const isFormal = stage === "formal_notice";
  const subject = isFormal ? `Laatste herinnering (14-dagenbrief) factuur ${inv.number}` : `Herinnering: factuur ${inv.number}`;
  const body = isFormal
    ? `<p>Beste ${escapeHtml(snap.name)},</p>
<p>Ondanks onze eerdere herinnering hebben wij de betaling van factuur <strong>${escapeHtml(inv.number!)}</strong> nog niet ontvangen. Het openstaande bedrag is <strong>${euro(outstanding)}</strong>.</p>
<p>Wij verzoeken u dit bedrag uiterlijk <strong>${dateNl(deadline)}</strong> te betalen. Dat is binnen 14 dagen na de dag van ontvangst van deze brief.</p>
<p>Betaalt u niet binnen deze termijn, dan zijn wij genoodzaakt de vordering uit handen te geven. U bent dan naast het openstaande bedrag buitengerechtelijke incassokosten verschuldigd van <strong>${euro(costs!)}</strong> (berekend volgens het Besluit vergoeding voor buitengerechtelijke incassokosten), vermeerderd met de wettelijke rente.</p>
${button(url, "Nu betalen")}
<p style="font-size:13px;color:#5f6b62">Overmaken kan ook naar IBAN ${escapeHtml((company as { iban?: string }).iban ?? "")} t.n.v. ${escapeHtml(company.name)} onder vermelding van ${escapeHtml(inv.paymentReference ?? inv.number!)}. Heeft u vragen of bent u het niet eens met de factuur? Neem dan zo snel mogelijk contact met ons op.</p>`
    : `<p>Beste ${escapeHtml(snap.name)},</p>
<p>Volgens onze administratie staat factuur <strong>${escapeHtml(inv.number!)}</strong> nog open: <strong>${euro(outstanding)}</strong>. De vervaldatum was ${dateNl(inv.dueDate!)}.</p>
<p>Waarschijnlijk is dit aan uw aandacht ontsnapt. Wilt u het bedrag uiterlijk <strong>${dateNl(deadline)}</strong> betalen?</p>
${button(url, "Factuur betalen")}
<p style="font-size:13px;color:#5f6b62">Heeft u inmiddels betaald? Dan kunt u deze herinnering als niet verzonden beschouwen.</p>`;

  const mail = await sendEmail(db, deps.emailTransport, {
    to: snap.email,
    subject,
    template: `dunning.${stage}`,
    customerId: inv.customerId,
    related: { type: "invoice", id: inv.id },
    html: layout(company, body),
    text: body.replace(/<[^>]+>/g, "").replace(/\n{2,}/g, "\n\n"),
  });
  await db.transaction(async (tx) => {
    await tx.update(invoices).set({ dunningStage: stage, dunningStageAt: new Date() }).where(eq(invoices.id, inv.id));
    await tx.insert(dunningEvents).values({ invoiceId: inv.id, stage, outstandingCents: outstanding, collectionCostsCents: costs, deadline, emailId: mail.id });
    await recordAudit(tx, system, { action: `dunning.${stage}`, entityType: "invoice", entityId: inv.id, metadata: { outstandingCents: outstanding, deadline, emailStatus: mail.status } });
  });
}

/** Nieuwe betaallink zonder de factuurmail opnieuw te sturen. */
async function sendInvoiceLinkOnly(db: Db, deps: BillingDeps, invoiceId: string) {
  const token = randomToken();
  await db.update(invoices).set({ publicTokenHash: sha256(token) }).where(eq(invoices.id, invoiceId));
  return { url: `${deps.config.APP_BASE_URL.replace(/\/$/, "")}/factuur/${token}` };
}

