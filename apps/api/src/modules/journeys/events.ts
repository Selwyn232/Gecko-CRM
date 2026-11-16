/**
 * Gebeurtenissen waarop een project automatisch naar een volgende status kan gaan.
 * Per status in de klantreis in te stellen ("auto_on_events").
 */
export const JOURNEY_EVENTS = [
  "deposit.paid",
  "survey.scheduled",
  "survey.report_submitted",
  "survey.report_approved",
  "extra_work.proposed",
  "extra_work.accepted",
  "installation.scheduled",
  "installation.report_submitted",
  "installation.report_approved",
  "final.paid",
] as const;

export type JourneyEvent = (typeof JOURNEY_EVENTS)[number];

export const JOURNEY_EVENT_LABELS: Record<JourneyEvent, string> = {
  "deposit.paid": "Aanbetaling betaald",
  "survey.scheduled": "Schouw ingepland",
  "survey.report_submitted": "Schouwrapport ingediend",
  "survey.report_approved": "Schouwrapport goedgekeurd (zonder meerwerk)",
  "extra_work.proposed": "Meerwerk voorgesteld aan klant",
  "extra_work.accepted": "Meerwerk geaccepteerd door klant",
  "installation.scheduled": "Installatie ingepland",
  "installation.report_submitted": "Opleverrapport ingediend",
  "installation.report_approved": "Opleverrapport goedgekeurd",
  "final.paid": "Eindfactuur betaald",
};
