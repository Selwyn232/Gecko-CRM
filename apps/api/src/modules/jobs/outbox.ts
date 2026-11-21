import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { outboxEvents } from "../events/schema.js";
import { invoiceProjectAndSend, type BillingDeps } from "../invoices/service.js";
import { applyJourneyEvent } from "../journeys/auto.js";
import type { JourneyEvent } from "../journeys/events.js";
import { journeyStatuses } from "../journeys/schema.js";
import { statusByKeyInJourneyOf } from "../journeys/service.js";
import { sendStatusMessage } from "../messages/service.js";
import type { Permission } from "../auth/permissions.js";
import { notifyPermission } from "../tasks/service.js";
import { projects } from "../projects/schema.js";
import { assignOnSignedOrder, releaseIfDone } from "../specialists/service.js";

const MAX_ATTEMPTS = 5;
const system: ActorContext = { userId: null, organizationId: null, permissions: new Set() };

type Handler = (db: Db, deps: BillingDeps, payload: Record<string, unknown>, eventId: number) => Promise<void>;

/**
 * Automatiseringen per gebeurtenistype. Nieuwe automatisering = hier een handler toevoegen.
 */
/** Melding in het CRM voor iedereen met het recht; één keer per gebeurtenis (outbox-id). */
const notifyOnce = (db: Db, eventId: number, permission: Permission, n: { title: string; body?: string | null; href?: string | null }) =>
  notifyPermission(db, permission, { ...n, dedupeKey: `event:${eventId}` });

const HANDLERS: Record<string, Handler[]> = {
  "report.submitted": [
    async (db, _deps, payload, eventId) => {
      const [p] = await db.select({ number: projects.number }).from(projects).where(eq(projects.id, String(payload.projectId)));
      await notifyOnce(db, eventId, "planning.manage", {
        title: `${payload.type === "survey" ? "Schouwrapport" : "Opleverrapport"} ingediend`,
        body: p ? `Project P-${String(p.number).padStart(6, "0")} — beoordelen` : null,
        href: "/planning",
      });
    },
  ],
  "quote.accepted": [
    async (db, _deps, payload, eventId) => {
      await notifyOnce(db, eventId, "quotes.manage", { title: "Offerte geaccepteerd door de klant", body: null, href: `/offertes/${String(payload.quoteId)}` });
    },
    // B81: getekende order → vaste klantspecialist + welkomstbericht (als de klant er nog geen heeft).
    async (db, deps, payload, eventId) => {
      if (payload.customerId) await assignOnSignedOrder(db, deps, String(payload.customerId), eventId);
    },
  ],
  "invoice.collection": [
    async (db, _deps, payload, eventId) => {
      await notifyOnce(db, eventId, "invoices.manage", { title: "Factuur overgedragen voor incasso", body: null, href: `/facturen/${String(payload.invoiceId)}` });
    },
  ],
  "invoice.paid": [
    async (db, _deps, payload) => {
      const type = payload.type as string;
      if (payload.projectId && (type === "deposit" || type === "final")) {
        await applyJourneyEvent(db, String(payload.projectId), type === "deposit" ? "deposit.paid" : "final.paid");
      }
    },
  ],
  "journey.event": [
    async (db, _deps, payload) => {
      await applyJourneyEvent(db, String(payload.projectId), payload.event as JourneyEvent);
    },
  ],
  "project.status_changed": [
    // B81: alle projecten van de klant in een eindstatus → specialist los; na een afgeronde installatie naar Service.
    async (db, _deps, payload) => {
      await releaseIfDone(db, String(payload.projectId));
    },
    async (db, deps, payload) => {
      const [row] = await db
        .select({ trigger: journeyStatuses.invoiceTrigger })
        .from(projects)
        .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
        .where(eq(projects.id, String(payload.projectId)));
      // Alleen factureren als het project nog steeds in die status staat met een factuurtrigger.
      if (row?.trigger === "deposit" || row?.trigger === "final") {
        await invoiceProjectAndSend(db, deps, system, String(payload.projectId), row.trigger);
      }
    },
    // Klantbericht bij de bereikte status (als daarvoor een actief bericht is ingesteld).
    async (db, deps, payload, eventId) => {
      const projectId = String(payload.projectId);
      let statusId = payload.toStatusId as string | undefined;
      if (!statusId) {
        // Oudere gebeurtenissen hebben alleen de sleutel van de status.
        const [p] = await db.select({ statusId: projects.statusId }).from(projects).where(eq(projects.id, projectId));
        statusId = p ? (await statusByKeyInJourneyOf(db, p.statusId, String(payload.toStatusKey)))?.id : undefined;
      }
      if (statusId) await sendStatusMessage(db, deps.emailTransport, projectId, statusId, `project.status:${eventId}`);
    },
  ],
};

/** Verwerkt openstaande gebeurtenissen. Veilig bij meerdere processen (SKIP LOCKED). */
export async function processOutbox(db: Db, deps: BillingDeps, batch = 20) {
  let done = 0;
  for (let i = 0; i < batch; i++) {
    const handled = await db.transaction(async (tx) => {
      const [ev] = await tx
        .select()
        .from(outboxEvents)
        .where(and(isNull(outboxEvents.processedAt), lt(outboxEvents.attempts, MAX_ATTEMPTS)))
        .orderBy(asc(outboxEvents.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!ev) return false;
      try {
        for (const h of HANDLERS[ev.type] ?? []) await h(db, deps, ev.payload as Record<string, unknown>, Number(ev.id));
        await tx.update(outboxEvents).set({ processedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1`, lastError: null }).where(eq(outboxEvents.id, ev.id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ level: 50, msg: "outbox_handler_failed", eventId: ev.id, type: ev.type, error: message }));
        await tx.update(outboxEvents).set({ attempts: sql`${outboxEvents.attempts} + 1`, lastError: message.slice(0, 1000) }).where(eq(outboxEvents.id, ev.id));
      }
      return true;
    });
    if (!handled) break;
    done++;
  }
  return done;
}
