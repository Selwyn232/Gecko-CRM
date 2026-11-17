import type { PdfText } from "./pdf.js";

/**
 * Uitlezen van een offerte-PDF van Greenteam (artikelblad met "Offerte #…", "Gegevens aanvrager",
 * "Gegevens uitvoerder", "Gegevens adviseur", regels met OMSCHRIJVING/AANTAL en totalen).
 * Puur: krijgt de tekst met posities, geeft gestructureerde gegevens plus waarschuwingen terug.
 */

export interface ParsedQuoteLine {
  description: string;
  quantity: number;
}

export interface ParsedGreenteamQuote {
  externalNumber: string;
  quoteDate: string | null;
  validUntil: string | null;
  customer: {
    /** Zoals op de offerte, bv. "I.M.M. Rozeboom-Priem". */
    fullName: string;
    firstName: string | null;
    lastName: string;
    street: string | null;
    houseNumber: string | null;
    houseNumberAddition: string | null;
    postalCode: string | null;
    city: string | null;
    email: string | null;
    phone: string | null;
  };
  installer: { name: string | null; email: string | null; phone: string | null };
  advisor: { organization: string | null; name: string | null; email: string | null; phone: string | null };
  depositMethod: string | null;
  lines: ParsedQuoteLine[];
  subtotalCents: number | null;
  vatCents: number | null;
  vatLabel: string | null;
  totalCents: number | null;
  /** Datum van ondertekening door de klant (alleen als die op de PDF staat), anders null. */
  signedDate: string | null;
  /** Productgroep afgeleid uit de regels (sleutel), of null. */
  productGroupKey: string | null;
  /** Wat ontbrak of twijfelachtig is; leeg = alles gevonden. */
  warnings: string[];
}

const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

/** "16 november 2026" → "2026-11-16". */
export function parseDutchDate(s: string | null | undefined): string | null {
  const m = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i.exec((s ?? "").trim());
  const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  if (!m || !month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

/** "€ 10.826,40" → 1082640. */
export function parseEuroCents(s: string | null | undefined): number | null {
  const m = /(-?)\s*([\d.]+),(\d{2})/.exec(s ?? "");
  if (!m) return null;
  const v = Number(m[2]!.replace(/\./g, "")) * 100 + Number(m[3]);
  return m[1] ? -v : v;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE = /^\+?[\d\s()-]{8,20}$/;
const POSTAL_CITY = /^(\d{4})\s?([A-Za-z]{2})\s+(.+)$/;

/** "Trêd 75 75" → straat "Trêd", nummer "75". "Dorpsstraat 12A" → 12 + A. "Laan 3-bis 3" → laan, 3, bis. */
export function splitAddress(line: string) {
  const tokens = line.trim().split(/\s+/);
  // Greenteam zet het huisnummer soms dubbel ("straat nr nr"): laatste token weg als het gelijk is aan het voorlaatste.
  if (tokens.length >= 3 && tokens.at(-1) === tokens.at(-2)) tokens.pop();
  const idx = tokens.findIndex((t, i) => i > 0 && /^\d/.test(t));
  if (idx < 0) return { street: line.trim(), houseNumber: null, houseNumberAddition: null };
  const street = tokens.slice(0, idx).join(" ");
  const rest = tokens.slice(idx).join(" ");
  const m = /^(\d+)\s*[-/]?\s*(.*)$/.exec(rest)!;
  return { street, houseNumber: m[1]!, houseNumberAddition: m[2]?.trim() || null };
}

/** "I.M.M. Rozeboom-Priem" → voorletters "I.M.M.", achternaam "Rozeboom-Priem". "Jan de Vries" → "Jan", "de Vries". */
export function splitName(full: string) {
  const s = full.trim().replace(/\s+/g, " ");
  const tussen = new Set(["van", "de", "der", "den", "het", "ten", "ter", "te", "in", "'t", "von", "le", "la", "du"]);
  const parts = s.split(" ");
  if (parts.length === 1) return { firstName: null, lastName: s };
  let i = 1;
  // Voornaam/voorletters = eerste deel (plus extra voorletters "J. P."), achternaam vanaf het eerste tussenvoegsel of laatste deel.
  while (i < parts.length - 1 && /^[A-Z]\.?$/.test(parts[i]!)) i++;
  let j = i;
  while (j < parts.length - 1 && !tussen.has(parts[j]!.toLowerCase())) j++;
  if (!tussen.has(parts[j]!.toLowerCase())) j = Math.max(i, parts.length - 1);
  return { firstName: parts.slice(0, j).join(" "), lastName: parts.slice(j).join(" ") };
}

const GROUP_KEYWORDS: [string, RegExp][] = [
  ["warmtepomp", /warmtepomp|heat ?pump|binnenunit|buitenunit|buffervat/i],
  ["thuisbatterij", /batter|kWh\b|BMS|EMS|omvormer.*fasen|hybride omvormer/i],
  ["zonnepanelen", /zonnepane|paneel|panelen|\bWp\b|optimizer/i],
  ["isolatie", /isolatie|spouw|vloerisolatie|dakisolatie/i],
];

export function guessProductGroup(lines: ParsedQuoteLine[]): string | null {
  const score = new Map<string, number>();
  for (const l of lines) for (const [key, re] of GROUP_KEYWORDS) if (re.test(l.description)) score.set(key, (score.get(key) ?? 0) + 1);
  const best = [...score.entries()].sort((a, b) => b[1] - a[1]);
  return best[0]?.[0] ?? null;
}

/** Tekst in een kolom (x ≈ kolom-x) onder een kop, van boven naar beneden, tot de eerstvolgende y-grens. */
function column(items: PdfText[], x: number, fromY: number, toY: number) {
  return items
    .filter((t) => Math.abs(t.x - x) < 6 && t.y < fromY && t.y > toY)
    .sort((a, b) => b.y - a.y)
    .map((t) => t.str);
}

const find = (items: PdfText[], re: RegExp) => items.find((t) => re.test(t.str));
/** Tekst rechts van een label op dezelfde regel. */
const rightOf = (items: PdfText[], label: PdfText | undefined) =>
  label ? items.filter((t) => Math.abs(t.y - label.y) < 3 && t.x > label.x + 5).sort((a, b) => a.x - b.x).map((t) => t.str).join(" ") || null : null;
/** Tekst direct onder een label (zelfde x). */
const below = (items: PdfText[], label: PdfText | undefined) =>
  label ? (items.filter((t) => Math.abs(t.x - label.x) < 6 && t.y < label.y && label.y - t.y < 25).sort((a, b) => b.y - a.y)[0]?.str ?? null) : null;

export function isGreenteamQuote(pages: PdfText[][]) {
  return pages.some((p) => p.some((t) => /^Offerte #\d+/.test(t.str)) && p.some((t) => t.str === "Gegevens aanvrager"));
}

export function parseGreenteamQuote(pages: PdfText[][]): ParsedGreenteamQuote {
  const page = pages.find((p) => p.some((t) => /^Offerte #\d+/.test(t.str)) && p.some((t) => t.str === "Gegevens aanvrager"));
  if (!page) throw new Error("Geen Greenteam-offerte: pagina met 'Offerte #' en 'Gegevens aanvrager' niet gevonden");
  const warnings: string[] = [];

  const title = find(page, /^Offerte #\d+/)!;
  const externalNumber = /#(\d+)/.exec(title.str)![1]!;
  const quoteDate = parseDutchDate(below(page, find(page, /^Datum:$/)));
  const validUntil = parseDutchDate(below(page, find(page, /^Vervaldatum:$/)));

  const hAanvrager = find(page, /^Gegevens aanvrager$/)!;
  const hUitvoerder = find(page, /^Gegevens uitvoerder$/);
  const hAdviseur = find(page, /^Gegevens adviseur$/);
  const depositLabel = find(page, /^Aanbetalingsmethode:?$/);
  const headerTable = find(page, /^OMSCHRIJVING$/);
  const bottom = depositLabel?.y ?? headerTable?.y ?? hAanvrager.y - 120;

  // Aanvrager: naam eerst, daarna herkenbaar aan de vorm (e-mail, telefoon, postcode+plaats, overig = adres).
  const aLines = column(page, hAanvrager.x, hAanvrager.y, bottom);
  const fullName = aLines[0] ?? "";
  if (!fullName) warnings.push("Naam aanvrager niet gevonden");
  let email: string | null = null;
  let phone: string | null = null;
  let postalCode: string | null = null;
  let city: string | null = null;
  let addressLine: string | null = null;
  for (const l of aLines.slice(1)) {
    if (EMAIL.test(l)) email = l.toLowerCase();
    else if (POSTAL_CITY.test(l)) {
      const m = POSTAL_CITY.exec(l)!;
      postalCode = `${m[1]}${m[2]!.toUpperCase()}`;
      city = m[3]!.trim();
    } else if (PHONE.test(l)) phone = l.replace(/[\s()-]/g, "");
    else if (!addressLine) addressLine = l;
  }
  const addr = addressLine ? splitAddress(addressLine) : { street: null, houseNumber: null, houseNumberAddition: null };
  if (!addr.street || !addr.houseNumber) warnings.push("Adres (straat en huisnummer) niet volledig gevonden");
  if (!postalCode) warnings.push("Postcode en plaats niet gevonden");
  if (!email && !phone) warnings.push("Geen e-mailadres of telefoonnummer gevonden");
  const name = splitName(fullName);

  const contact = (h: PdfText | undefined) => {
    const ls = h ? column(page, h.x, h.y, bottom) : [];
    return {
      name: ls[0] ?? null,
      email: ls.find((l) => EMAIL.test(l))?.toLowerCase() ?? null,
      phone: ls.slice(1).find((l) => PHONE.test(l) && !POSTAL_CITY.test(l))?.replace(/[\s()-]/g, "") ?? null,
    };
  };
  const inst = contact(hUitvoerder);
  const adv = contact(hAdviseur);
  // "Greenteam - Jorn Nieuwenhuis"
  const advSplit = adv.name ? /^(.+?)\s+[-–]\s+(.+)$/.exec(adv.name) : null;
  const advisor = { organization: advSplit?.[1]?.trim() ?? null, name: (advSplit?.[2] ?? adv.name)?.trim() ?? null, email: adv.email, phone: adv.phone };
  if (!advisor.name) warnings.push("Adviseur niet gevonden");

  // Regels: omschrijving links, aantal in de kolom AANTAL. Een omschrijving over twee regels hoort bij het aantal dat er verticaal tussen staat.
  const hAantal = find(page, /^AANTAL$/);
  const end = find(page, /^Akkoord aanvrager\.?$/)?.y ?? 0;
  const lines: ParsedQuoteLine[] = [];
  if (headerTable && hAantal) {
    const inTable = (t: PdfText) => t.y < headerTable.y - 2 && t.y > end + 2;
    const qtys = page.filter((t) => inTable(t) && Math.abs(t.x - hAantal.x) < 45 && /^\d+([.,]\d+)?$/.test(t.str)).sort((a, b) => b.y - a.y);
    const descs = page.filter((t) => inTable(t) && t.x < hAantal.x - 20);
    const byQty = new Map<PdfText, PdfText[]>(qtys.map((q) => [q, []]));
    for (const d of descs) {
      let best: PdfText | null = null;
      for (const q of qtys) if (Math.abs(q.y - d.y) <= 12 && (!best || Math.abs(q.y - d.y) < Math.abs(best.y - d.y))) best = q;
      if (best) byQty.get(best)!.push(d);
      else warnings.push(`Tekst zonder aantal overgeslagen: "${d.str}"`);
    }
    for (const q of qtys) {
      const description = byQty.get(q)!.sort((a, b) => b.y - a.y).map((d) => d.str).join(" ").replace(/\s+/g, " ").trim();
      if (description) lines.push({ description, quantity: Number(q.str.replace(",", ".")) });
    }
  }
  if (!lines.length) warnings.push("Geen offerteregels gevonden");

  const amount = (re: RegExp) => {
    const label = find(page, re);
    return { label, cents: parseEuroCents(rightOf(page, label)) };
  };
  const sub = amount(/^Subtotaal$/);
  const vat = amount(/^BTW\b/i);
  const tot = amount(/^Totaal$/);
  if (sub.cents == null || tot.cents == null) warnings.push("Bedragen (subtotaal/totaal) niet gevonden");
  else if (vat.cents != null && sub.cents + vat.cents !== tot.cents) warnings.push("Subtotaal + btw is niet gelijk aan het totaal");

  // Ondertekend alleen als er onder "Voor akkoord: Aanvrager" (linkerhelft) een echte datum staat.
  const akkoord = find(page, /^Voor akkoord: Aanvrager/);
  const half = (find(page, /^Voor akkoord: Adviseur/)?.x ?? 300) - 10;
  const signDateLabel = akkoord ? page.find((t) => /^Datum:$/.test(t.str) && t.y < akkoord.y && t.x < half) : undefined;
  const signedDate = signDateLabel
    ? parseDutchDate(page.filter((t) => Math.abs(t.y - signDateLabel.y) < 3 && t.x > signDateLabel.x && t.x < half).sort((a, b) => a.x - b.x)[0]?.str)
    : null;

  return {
    externalNumber,
    quoteDate,
    validUntil,
    customer: { fullName, firstName: name.firstName, lastName: name.lastName, ...addr, postalCode, city, email, phone },
    installer: inst,
    advisor,
    depositMethod: rightOf(page, depositLabel),
    lines,
    subtotalCents: sub.cents,
    vatCents: vat.cents,
    vatLabel: vat.label?.str ?? null,
    totalCents: tot.cents,
    signedDate,
    productGroupKey: guessProductGroup(lines),
    warnings,
  };
}
