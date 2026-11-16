/** Het bedrijf werkt in Nederlandse tijd; "vandaag" is dus de datum in Europe/Amsterdam. */
export const BUSINESS_TIMEZONE = "Europe/Amsterdam";

/** Datum als YYYY-MM-DD in Nederlandse tijd. */
export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
