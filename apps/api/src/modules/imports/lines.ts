/** Regels van een externe offerte omzetten naar producten en prijzen. Puur, zonder database. */

export type LineType = "package" | "component" | "labor" | "extra_work" | "service";

/** Sleutel om omschrijvingen te vergelijken: kleine letters, zonder accenten, enkele spaties. */
export function descriptionKey(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Voorwaarden op de offerte die geen product zijn ("Onder voorbehoud van financiering …"). */
export const isConditionLine = (description: string) => /onder voorbehoud|voorbehoud van financiering/i.test(description);

/**
 * Producttype raden uit de omschrijving, voor een nieuw product:
 * werkzaamheden → arbeid, service/subsidie/financiering → dienst, de rest → component.
 */
export function guessLineType(description: string): LineType {
  const d = description.toLowerCase();
  if (/^service\b|subsidie|financiering|btw-teruggave|btw teruggave/.test(d)) return "service";
  if (/^installatie\b|installatie(-|\s)?opname|aansluiten|montage|leidingwerk|kabeltraject|technische inspectie|aanpassen groepenkast|\binstallatie op\b|\bcv installatie\b/.test(d)) return "labor";
  return "component";
}

/**
 * Prijs per regel zodat het totaal exact de afgesproken prijs (excl. btw) van de offerte is.
 * Regels met een verkoopprijs in de catalogus houden die; de eerste regel (het hoofdproduct) krijgt het restant.
 * Is het restant negatief, dan staat de hele prijs op de eerste regel en de rest op 0.
 */
export function allocatePrices(lines: { quantity: number; catalogUnitCents: number | null }[], subtotalCents: number) {
  if (!lines.length) return [];
  const others = lines.slice(1).map((l) => l.catalogUnitCents ?? 0);
  const othersTotal = lines.slice(1).reduce((s, l, i) => s + Math.round(others[i]! * l.quantity), 0);
  const mainQty = lines[0]!.quantity || 1;
  const rest = subtotalCents - othersTotal;
  if (rest < 0) return [Math.round(subtotalCents / mainQty), ...others.map(() => 0)];
  return [Math.round(rest / mainQty), ...others];
}
