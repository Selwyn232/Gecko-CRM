import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { appSettings } from "./schema.js";

/**
 * Alle instelbare waarden met hun standaard en validatie. Nieuwe instelling = hier toevoegen;
 * het beheerscherm toont ze automatisch.
 */
export const SETTINGS = {
  "invoice.payment_term_days": { label: "Betaaltermijn facturen (dagen)", schema: z.number().int().min(1).max(90), default: 14 },
  "invoice.deposit_basis_points": { label: "Aanbetaling (% × 100, 7000 = 70%)", schema: z.number().int().min(0).max(10000), default: 7000 },
  "dunning.enabled": { label: "Automatische herinneringen en aanmaningen", schema: z.boolean(), default: true },
  "dunning.reminder_days_after_due": { label: "Herinnering: dagen na vervaldatum", schema: z.number().int().min(0).max(60), default: 0 },
  "dunning.reminder_term_days": { label: "Herinnering: betalen binnen (dagen)", schema: z.number().int().min(1).max(30), default: 5 },
  "dunning.formal_term_days": {
    label: "14-dagenbrief (WIK): betalen binnen (dagen, wettelijk minimaal 14)",
    schema: z.number().int().min(14).max(60),
    default: 14,
  },
  "dunning.collection_after_days": { label: "Overdracht incasso: dagen na verstrijken 14-dagenbrief", schema: z.number().int().min(1).max(60), default: 1 },
  "invoice.deposit_due_days_before_survey": {
    label: "Aanbetaling moet binnen zijn: dagen vóór de schouw",
    schema: z.number().int().min(0).max(30),
    default: 2,
  },
  "planning.survey_lead_days": { label: "Schouw op zijn vroegst over (dagen)", schema: z.number().int().min(0).max(60), default: 3 },
  "planning.installation_lead_days": { label: "Installatie op zijn vroegst over (dagen, levertijd materiaal)", schema: z.number().int().min(0).max(90), default: 7 },
  "planning.horizon_days": { label: "Planning: zoeken tot (dagen vooruit)", schema: z.number().int().min(7).max(365), default: 56 },
  "quote.change_window_days": { label: "Klant mag afspraak verzetten tot (dagen vooraf)", schema: z.number().int().min(0).max(60), default: 14 },
} as const;

export type SettingKey = keyof typeof SETTINGS;
type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]["default"] extends number ? number : boolean;

export async function getSetting<K extends SettingKey>(db: DbOrTx, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  const parsed = row ? SETTINGS[key].schema.safeParse(row.value) : null;
  return (parsed?.success ? parsed.data : SETTINGS[key].default) as SettingValue<K>;
}

export async function listSettings(db: DbOrTx) {
  const rows = await db.select().from(appSettings);
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const row = rows.find((r) => r.key === key);
    return { key, label: SETTINGS[key].label, default: SETTINGS[key].default, value: row ? row.value : SETTINGS[key].default, isDefault: !row };
  });
}

export async function setSetting(db: DbOrTx, actor: ActorContext, key: string, value: unknown) {
  if (!(key in SETTINGS)) throw badRequest("unknown_setting", "Onbekende instelling");
  const def = SETTINGS[key as SettingKey];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw badRequest("invalid_setting", `Ongeldige waarde voor "${def.label}"`);
  const before = await getSetting(db, key as SettingKey);
  await db
    .insert(appSettings)
    .values({ key, value: parsed.data, updatedBy: actor.userId })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: parsed.data, updatedAt: new Date(), updatedBy: actor.userId } });
  await recordAudit(db, actor, { action: "setting.updated", entityType: "setting", entityId: key, before: { value: before }, after: { value: parsed.data } });
}
