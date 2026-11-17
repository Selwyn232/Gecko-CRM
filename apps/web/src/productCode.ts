import type { ProductType } from "./api";

/**
 * Voorstel voor een productcode, herleidbaar tot de ingevoerde velden:
 *   TYPE-GROEP[-LEVERANCIER]-NAAM
 * bv. "Kstar batterij 10 kW", component, Thuisbatterij, OSW → CMP-BAT-OSW-KSTAR-10KW.
 *
 * - TYPE: vaste afkorting per producttype.
 * - GROEP: vaste afkorting per productgroep (onbekende groep: eerste 3 letters van de naam).
 * - LEVERANCIER: eerste 3 letters van de standaardleverancier, alleen als die is gekozen.
 * - NAAM: de kenmerkende woorden uit de naam; getal + eenheid samen (10 kWh → 10KWH),
 *   woorden tot 6 letters voluit, langere ingekort tot 4. Woorden die al in type of groep zitten vallen weg.
 * Bestaat de code al, dan volgt -2, -3, …
 */

export const TYPE_ABBR: Record<ProductType, string> = {
  package: "PKG",
  component: "CMP",
  labor: "ARB",
  extra_work: "MW",
  service: "DNS",
};

const GROUP_ABBR: Record<string, string> = {
  thuisbatterij: "BAT",
  zonnepanelen: "ZP",
  warmtepomp: "WP",
  isolatie: "ISO",
};

/** Woorden die de groep al uitdrukt (per groepssleutel). */
const GROUP_WORDS: Record<string, string[]> = {
  thuisbatterij: ["THUISBATTERIJ", "BATTERIJ", "THUISACCU", "ACCU"],
  zonnepanelen: ["ZONNEPANELEN", "ZONNEPANEEL", "PANELEN", "ZONNE"],
  warmtepomp: ["WARMTEPOMP", "WARMTEPOMPEN"],
  isolatie: ["ISOLATIE"],
};

const TYPE_WORDS: Record<ProductType, string[]> = {
  package: ["PAKKET", "PAKKETTEN", "COMPLEET", "GEINSTALLEERD", "ALL", "IN", "ALLIN"],
  component: [],
  labor: ["INSTALLATIE", "INSTALLEREN", "MONTEREN", "ARBEID"],
  extra_work: ["MEERWERK"],
  service: ["DIENST"],
};

const STOP = new Set(["DE", "HET", "EEN", "EN", "VAN", "MET", "VOOR", "OP", "TOT", "INCL", "INCLUSIEF", "EXCL", "EXCLUSIEF", "PER", "VOORBEELD"]);
const UNITS = new Set(["KWH", "KW", "WP", "W", "KWP", "MM", "CM", "M", "M2", "M3", "L", "LTR", "A", "V", "ST", "STUKS"]);

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/(\d),(\d)/g, "$1.$2");

function shortWord(w: string) {
  return w.length <= 6 ? w : w.slice(0, 4);
}

/** Afkorting voor een vrije naam (leverancier, onbekende groep). */
export function abbreviate(name: string, length = 3) {
  return normalize(name).replace(/[^A-Z0-9]/g, "").slice(0, length);
}

export function groupAbbr(group: { key: string; name: string }) {
  return GROUP_ABBR[group.key] ?? abbreviate(group.name);
}

/** Kenmerkende delen van de naam. */
export function nameParts(name: string, type: ProductType, groupKey: string | null) {
  const tokens = normalize(name)
    .replace(/\(.*?\)/g, " ")
    .split(/[^A-Z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  const drop = new Set([...STOP, ...TYPE_WORDS[type], ...(groupKey ? (GROUP_WORDS[groupKey] ?? []) : [])]);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d+(\.\d+)?$/.test(t)) {
      const next = tokens[i + 1];
      const num = t; // 2,5 kW → 2.5KW
      if (next && UNITS.has(next)) {
        parts.push(num + next);
        i++;
      } else parts.push(num);
      continue;
    }
    // "10kWh" als één woord
    const m = /^(\d+(?:\.\d+)?)([A-Z0-9]+)$/.exec(t);
    if (m && UNITS.has(m[2]!)) {
      parts.push(m[1]! + m[2]);
      continue;
    }
    if (drop.has(t)) continue;
    parts.push(shortWord(t));
  }
  // Maximaal 4 delen; getallen (maat, vermogen) gaan voor woorden, de volgorde blijft die van de naam.
  const nums = parts.filter((x) => /^\d/.test(x)).slice(0, 2);
  let words = 4 - nums.length;
  return parts.filter((x) => (/^\d/.test(x) ? nums.includes(x) : words-- > 0));
}

export interface CodeSuggestion {
  code: string;
  /** Uitleg per deel, voor onder het invoerveld. */
  explain: { part: string; from: string }[];
}

export function suggestProductCode(
  input: { name: string; type: ProductType; group: { key: string; name: string } | null; supplierName: string | null },
  existingCodes: Iterable<string>,
): CodeSuggestion | null {
  if (!input.name.trim() || !input.group) return null;
  const explain: { part: string; from: string }[] = [
    { part: TYPE_ABBR[input.type], from: "type" },
    { part: groupAbbr(input.group), from: `productgroep ${input.group.name}` },
  ];
  if (input.supplierName) explain.push({ part: abbreviate(input.supplierName), from: `leverancier ${input.supplierName}` });
  const np = nameParts(input.name, input.type, input.group.key);
  if (np.length) explain.push({ part: np.join("-"), from: "naam" });
  const base = explain.map((e) => e.part).join("-").slice(0, 46).replace(/-+$/, "");
  const taken = new Set([...existingCodes].map((c) => c.toUpperCase()));
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
  if (code !== base) explain.push({ part: code.slice(base.length + 1), from: "volgnummer (code bestond al)" });
  return { code, explain };
}
