import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { travelTimes } from "./schema.js";

/**
 * B87: rijtijden tussen klussen via Google Maps (Distance Matrix). We sturen alleen postcodes (geen namen of
 * huisnummers) naar Google. Uitkomsten worden 30 dagen bewaard. Zonder sleutel of bij een storing: een
 * voorzichtige schatting op basis van de postcode.
 */
export const normalizePostal = (pc: string) => pc.replace(/\s+/g, "").toUpperCase();

const CACHE_DAYS = 30;
const ROUND_UP = 5;

/** Schatting zonder Google: hoe verder de postcodes uit elkaar liggen, hoe langer. */
export function estimateMinutes(from: string, to: string) {
  const a = normalizePostal(from);
  const b = normalizePostal(to);
  if (a === b) return 5;
  if (a.slice(0, 4) === b.slice(0, 4)) return 10;
  if (a.slice(0, 3) === b.slice(0, 3)) return 20;
  if (a.slice(0, 2) === b.slice(0, 2)) return 30;
  if (a.slice(0, 1) === b.slice(0, 1)) return 50;
  return 80;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
let fetcher: Fetcher = (url) => fetch(url);
/** Voor tests: Google-aanroepen nabootsen. */
export function setTravelFetcher(f: Fetcher | null) {
  fetcher = f ?? ((url) => fetch(url));
}

interface MatrixResponse {
  status?: string;
  rows?: { elements?: { status?: string; duration?: { value: number }; duration_in_traffic?: { value: number } }[] }[];
}

const place = (p: string) => (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(p) ? p : `${normalizePostal(p)},Nederland`);

async function google(origins: string[], destinations: string[]) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json?mode=driving&language=nl&region=nl" +
    `&origins=${encodeURIComponent(origins.map(place).join("|"))}&destinations=${encodeURIComponent(destinations.map(place).join("|"))}` +
    `&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetcher(url);
    if (!res.ok) return null;
    const body = (await res.json()) as MatrixResponse;
    if (body.status !== "OK") return null;
    const out = new Map<string, number>();
    body.rows?.forEach((row, i) =>
      row.elements?.forEach((el, j) => {
        const sec = el.duration_in_traffic?.value ?? el.duration?.value;
        if (el.status === "OK" && typeof sec === "number") out.set(`${origins[i]}|${destinations[j]}`, Math.ceil(sec / 60 / ROUND_UP) * ROUND_UP);
      }),
    );
    return out;
  } catch {
    return null;
  }
}

/** Rijtijden (minuten) voor alle combinaties van herkomst en bestemming (postcodes). Sleutel "VAN|NAAR". */
export async function travelMatrix(db: DbOrTx, from: string[], to: string[]) {
  const origins = [...new Set(from.map(normalizePostal))];
  const dests = [...new Set(to.map(normalizePostal))];
  const result = new Map<string, number>();
  if (!origins.length || !dests.length) return result;
  const since = new Date(Date.now() - CACHE_DAYS * 86_400_000);
  const cached = await db.select().from(travelTimes).where(and(inArray(travelTimes.fromPostal, origins), inArray(travelTimes.toPostal, dests)));
  for (const c of cached) if (c.updatedAt >= since) result.set(`${c.fromPostal}|${c.toPostal}`, c.minutes);
  const missing: [string, string][] = [];
  for (const o of origins) for (const d of dests) if (o !== d && !result.has(`${o}|${d}`)) missing.push([o, d]);
  for (const o of origins) for (const d of dests) if (o === d) result.set(`${o}|${d}`, 5);
  // Per herkomst in blokken van 25 bestemmingen (limiet van Google).
  const byOrigin = new Map<string, string[]>();
  for (const [o, d] of missing) byOrigin.set(o, [...(byOrigin.get(o) ?? []), d]);
  for (const [o, ds] of byOrigin) {
    for (let i = 0; i < ds.length; i += 25) {
      const chunk = ds.slice(i, i + 25);
      const got = await google([o], chunk);
      for (const d of chunk) {
        const g = got?.get(`${o}|${d}`);
        if (g !== undefined) {
          result.set(`${o}|${d}`, g);
          await db
            .insert(travelTimes)
            .values({ fromPostal: o, toPostal: d, minutes: g, source: "google" })
            .onConflictDoUpdate({ target: [travelTimes.fromPostal, travelTimes.toPostal], set: { minutes: g, source: "google", updatedAt: new Date() } });
        } else {
          result.set(`${o}|${d}`, estimateMinutes(o, d));
        }
      }
    }
  }
  return result;
}

export const travelKey = (from: string, to: string) => `${normalizePostal(from)}|${normalizePostal(to)}`;

/** Rijtijd vanaf een actuele locatie (monteur onderweg) naar een postcode; null als Google niet beschikbaar is. */
export async function minutesFromLocation(lat: number, lng: number, postal: string) {
  const origin = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const got = await google([origin], [normalizePostal(postal)]);
  return got?.get(`${origin}|${normalizePostal(postal)}`) ?? null;
}

export async function cachedTravel(db: DbOrTx, from: string, to: string) {
  const [row] = await db.select().from(travelTimes).where(and(eq(travelTimes.fromPostal, normalizePostal(from)), eq(travelTimes.toPostal, normalizePostal(to))));
  return row?.minutes ?? null;
}
