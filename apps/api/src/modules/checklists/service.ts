import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups } from "../catalog/schema.js";
import { checklistItems, checklistSettings } from "./schema.js";

export type ChecklistType = "survey" | "installation";

/** Startinrichting (algemeen); de definitieve lijsten per productgroep stelt Gecko zelf in (O23). */
export const DEFAULT_CHECKLISTS: Record<ChecklistType, string[]> = {
  survey: ["Meterkast beoordeeld", "Locatie apparatuur bepaald", "Kabelroute bepaald", "Klant geïnformeerd over planning"],
  installation: ["Installatie getest en werkend", "Klant uitleg gegeven", "Werkplek opgeruimd", "Aangemeld/geregistreerd waar nodig"],
};

export async function getChecklist(db: DbOrTx, productGroupId: string, type: ChecklistType) {
  const items = await db
    .select({ id: checklistItems.id, label: checklistItems.label, required: checklistItems.required })
    .from(checklistItems)
    .where(and(eq(checklistItems.productGroupId, productGroupId), eq(checklistItems.type, type)))
    .orderBy(asc(checklistItems.sortOrder));
  const [s] = await db.select().from(checklistSettings).where(and(eq(checklistSettings.productGroupId, productGroupId), eq(checklistSettings.type, type)));
  return { items, minPhotos: s?.minPhotos ?? 0 };
}

export async function listChecklists(db: DbOrTx) {
  const groups = await db.select().from(productGroups).orderBy(asc(productGroups.sortOrder), asc(productGroups.name));
  return Promise.all(
    groups.map(async (g) => ({
      productGroup: { id: g.id, name: g.name, isActive: g.isActive },
      survey: await getChecklist(db, g.id, "survey"),
      installation: await getChecklist(db, g.id, "installation"),
    })),
  );
}

/** Vervangt de lijst in één keer (volgorde = volgorde van de items). */
export async function saveChecklist(
  db: DbOrTx,
  actor: ActorContext,
  productGroupId: string,
  type: ChecklistType,
  input: { items: { label: string; required: boolean }[]; minPhotos: number },
) {
  const labels = input.items.map((i) => i.label.trim());
  if (labels.some((l) => !l)) throw badRequest("empty_label", "Elk punt heeft een omschrijving nodig");
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw badRequest("duplicate_label", "Elk punt mag maar één keer voorkomen");
  const before = await getChecklist(db, productGroupId, type);
  await db.delete(checklistItems).where(and(eq(checklistItems.productGroupId, productGroupId), eq(checklistItems.type, type)));
  if (input.items.length) {
    await db.insert(checklistItems).values(input.items.map((i, n) => ({ productGroupId, type, label: i.label.trim(), required: i.required, sortOrder: n })));
  }
  await db
    .insert(checklistSettings)
    .values({ productGroupId, type, minPhotos: input.minPhotos })
    .onConflictDoUpdate({ target: [checklistSettings.productGroupId, checklistSettings.type], set: { minPhotos: input.minPhotos } });
  await recordAudit(db, actor, {
    action: "checklist.updated",
    entityType: "product_group",
    entityId: productGroupId,
    before: { type, items: before.items.map((i) => `${i.label}${i.required ? " (verplicht)" : ""}`), minPhotos: before.minPhotos },
    after: { type, items: input.items.map((i) => `${i.label}${i.required ? " (verplicht)" : ""}`), minPhotos: input.minPhotos },
  });
  return getChecklist(db, productGroupId, type);
}

/** Startlijsten voor productgroepen die nog geen checklist hebben (bestaande lijsten blijven ongemoeid). */
export async function ensureDefaultChecklists(db: DbOrTx) {
  const groups = await db.select({ id: productGroups.id }).from(productGroups);
  const existing = await db.select({ g: checklistItems.productGroupId, t: checklistItems.type }).from(checklistItems);
  const configured = await db.select({ g: checklistSettings.productGroupId, t: checklistSettings.type }).from(checklistSettings);
  for (const g of groups) {
    for (const type of ["survey", "installation"] as const) {
      if (existing.some((e) => e.g === g.id && e.t === type) || configured.some((c) => c.g === g.id && c.t === type)) continue;
      await db.insert(checklistItems).values(DEFAULT_CHECKLISTS[type].map((label, n) => ({ productGroupId: g.id, type, label, sortOrder: n })));
      await db.insert(checklistSettings).values({ productGroupId: g.id, type, minPhotos: 0 }).onConflictDoNothing();
    }
  }
}

/** Controle bij indienen van een positief rapport: verplichte punten afgevinkt en genoeg foto's. */
export function checkReport(list: Awaited<ReturnType<typeof getChecklist>>, checked: Record<string, boolean> | undefined, photoCount: number) {
  const missing = list.items.filter((i) => i.required && !checked?.[i.label]).map((i) => i.label);
  if (missing.length) throw badRequest("checklist_incomplete", `Nog niet afgevinkt (verplicht): ${missing.join(", ")}`);
  if (photoCount < list.minPhotos) throw badRequest("photos_required", `Voeg minimaal ${list.minPhotos} foto's toe (nu ${photoCount})`);
}
