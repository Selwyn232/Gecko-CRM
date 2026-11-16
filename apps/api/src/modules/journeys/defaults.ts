/**
 * Startinrichting van de klantreis (zie docs/03). Wordt per productgroep aangemaakt als die nog geen
 * statussen heeft. Daarna volledig aan te passen in het beheer.
 */
export interface DefaultStatus {
  key: string;
  name: string;
  phase: string;
  color: string;
  isInitial?: boolean;
  isFinal?: boolean;
  invoiceTrigger?: "deposit" | "final";
  autoOnEvents?: string[];
  next: string[];
}

export const DEFAULT_JOURNEY: DefaultStatus[] = [
  { key: "order_getekend", name: "Offerte getekend", phase: "Verkoop", color: "blue", isInitial: true, next: ["wacht_financiering", "schouw_inplannen"] },
  { key: "wacht_financiering", name: "Wacht op financiering", phase: "Financiering", color: "yellow", next: ["schouw_inplannen"] },
  { key: "schouw_inplannen", name: "Schouw in te plannen", phase: "Schouw", color: "yellow", next: ["schouw_ingepland"] },
  { key: "schouw_ingepland", name: "Schouw ingepland — aanbetaling open", phase: "Schouw", color: "blue", invoiceTrigger: "deposit", autoOnEvents: ["survey.scheduled"], next: ["aanbetaling_ontvangen", "schouw_inplannen"] },
  { key: "aanbetaling_ontvangen", name: "Aanbetaling ontvangen", phase: "Schouw", color: "green", autoOnEvents: ["deposit.paid"], next: ["schouw_uitgevoerd", "schouw_inplannen"] },
  { key: "schouw_uitgevoerd", name: "Schouw uitgevoerd — beoordelen", phase: "Schouw", color: "blue", autoOnEvents: ["survey.report_submitted"], next: ["meerwerk_akkoord", "installatie_inplannen"] },
  { key: "meerwerk_akkoord", name: "Meerwerk ter akkoord bij klant", phase: "Schouw", color: "yellow", autoOnEvents: ["extra_work.proposed"], next: ["installatie_inplannen"] },
  { key: "installatie_inplannen", name: "Installatie in te plannen", phase: "Installatie", color: "yellow", autoOnEvents: ["survey.report_approved", "extra_work.accepted"], next: ["installatie_ingepland"] },
  { key: "installatie_ingepland", name: "Installatie ingepland", phase: "Installatie", color: "blue", autoOnEvents: ["installation.scheduled"], next: ["oplevering_controle", "installatie_inplannen"] },
  { key: "oplevering_controle", name: "Opgeleverd — controle rapport", phase: "Installatie", color: "blue", autoOnEvents: ["installation.report_submitted"], next: ["eindfactuur_open", "installatie_inplannen"] },
  { key: "eindfactuur_open", name: "Eindfactuur open", phase: "Afronding", color: "yellow", invoiceTrigger: "final", autoOnEvents: ["installation.report_approved"], next: ["afgerond"] },
  { key: "afgerond", name: "Afgerond", phase: "Afronding", color: "green", isFinal: true, autoOnEvents: ["final.paid"], next: [] },
  { key: "geannuleerd", name: "Geannuleerd", phase: "Afronding", color: "red", isFinal: true, next: [] },
];

/** Annuleren kan vanuit elke niet-eindstatus. */
export const CANCEL_KEY = "geannuleerd";
