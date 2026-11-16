import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { outboxEvents } from "../events/schema.js";
import { invoiceProjectAndSend, type BillingDeps } from "../invoices/service.js";
import { applyJourneyEvent } from "../journeys/auto.js";
import type { JourneyEvent } from "../journeys/events.js";
import { journeyStatuses } from "../journeys/schema.js";
import { projects } from "../projects/schema.js";

const MAX_ATTEMPTS = 5;
const system: ActorContext = { userId: null, organizationId: null, permissions: new Set() };

type Handler = (db: Db, deps: BillingDeps, payload: Record<string, unknown>) => Promise<void>;

/**
 * Automatiseringen per gebeurtenistype. Nieuwe automatisering = hier een handler toevoegen.
 * (Later: door beheerders instelbare regels per status, zoals e-mail/WhatsApp-berichten.)
 */
const HANDLERS: Record<string, Handler[]> = {
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
        for (const h of HANDLERS[ev.type] ?? []) await h(db, deps, ev.payload as Record<string, unknown>);
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
