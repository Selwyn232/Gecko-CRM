import type { Db } from "../../db/client.js";
import { runDunning } from "../invoices/dunning.js";
import type { BillingDeps } from "../invoices/service.js";
import { sendAppointmentReminders } from "../planning/service.js";
import { autoWeeklyDrafts } from "../selfbilling/service.js";
import { processOutbox } from "./outbox.js";
import { purgeLocations } from "../technicians/service.js";

/**
 * Achtergrondtaken in hetzelfde proces als de API (één server is voldoende bij dit volume).
 * - automatiseringen: elke 5 seconden
 * - aanmaningen en afspraakherinneringen: elk uur (idempotent)
 * Bij opschalen naar meerdere servers: verplaatsen naar een aparte worker (pg-boss), zie docs/07.
 */
export function startScheduler(db: Db, deps: BillingDeps, log: (msg: string, data?: object) => void) {
  let busy = false;
  const outbox = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const n = await processOutbox(db, deps);
      if (n) log("outbox verwerkt", { events: n });
    } catch (err) {
      log("outbox fout", { error: String(err) });
    } finally {
      busy = false;
    }
  }, 5_000);

  const dunning = async () => {
    try {
      const r = await runDunning(db, deps);
      if (r.processed) log("aanmaningen verwerkt", r);
    } catch (err) {
      log("aanmaningen fout", { error: String(err) });
    }
    try {
      const r = await autoWeeklyDrafts(db);
      if (r.created) log("selfbilling-concepten aangemaakt", r);
    } catch (err) {
      log("selfbilling-bundeling fout", { error: String(err) });
    }
    try {
      await purgeLocations(db);
    } catch (err) {
      log("locaties opruimen fout", { error: String(err) });
    }
    try {
      const r = await sendAppointmentReminders(db, deps.emailTransport);
      if (r.sent) log("herinneringen afspraken verstuurd", r);
    } catch (err) {
      log("herinneringen fout", { error: String(err) });
    }
  };
  const dunningTimer = setInterval(dunning, 60 * 60_000);
  setTimeout(dunning, 30_000);

  return () => {
    clearInterval(outbox);
    clearInterval(dunningTimer);
  };
}
