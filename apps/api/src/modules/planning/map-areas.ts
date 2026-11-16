import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { regions } from "./schema.js";

/**
 * De 200 standaardgebieden van de kaart (aaneengesloten PC4-reeksen binnen een PC2-reeks).
 * Bron en opbouw: scripts/build-nl-gebieden.py. Bij opstarten aangemaakt als regio (idempotent).
 */
interface MapArea {
  code: string;
  name: string;
  from: number;
  to: number;
}

const FILE = fileURLToPath(new URL("../../../data/nl-gebieden.json", import.meta.url));

export function loadMapAreas(): MapArea[] {
  return (JSON.parse(readFileSync(FILE, "utf8")) as { areas: MapArea[] }).areas;
}

export async function ensureMapRegions(db: DbOrTx) {
  const areas = loadMapAreas();
  await db
    .insert(regions)
    .values(areas.map((a) => ({ name: a.name, mapCode: a.code, postalRanges: [[a.from, a.to]] as [number, number][] })))
    .onConflictDoUpdate({ target: regions.mapCode, set: { postalRanges: sql`excluded.postal_ranges` } });
}
