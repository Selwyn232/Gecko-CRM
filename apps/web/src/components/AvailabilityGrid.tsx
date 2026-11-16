import { useState } from "react";
import type { AvailabilityRow, Region } from "../api";
import { addDaysIso, todayIso, weekday } from "../format";
import { ErrorBox } from "./ui";

interface Props {
  regions: Region[];
  rows: AvailabilityRow[];
  weeks: number;
  onSave: (entries: { regionId: string; date: string; surveySlots: number; installationSlots: number }[]) => Promise<unknown>;
}

/** Raster datum × regio met het aantal schouwen (S) en installaties (I) per dag. Weekend standaard verborgen. */
export function AvailabilityGrid({ regions, rows, weeks, onSave }: Props) {
  const [edits, setEdits] = useState<Record<string, { s: number; i: number }>>({});
  const [showWeekend, setShowWeekend] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const today = todayIso();
  const dates = Array.from({ length: weeks * 7 }, (_, i) => addDaysIso(today, i)).filter((d) => {
    const day = new Date(`${d}T12:00:00`).getDay();
    return showWeekend || (day !== 0 && day !== 6);
  });
  const key = (regionId: string, date: string) => `${regionId}|${date}`;
  const row = (regionId: string, date: string) => rows.find((r) => r.regionId === regionId && r.date === date);
  const value = (regionId: string, date: string) => edits[key(regionId, date)] ?? { s: row(regionId, date)?.surveySlots ?? 0, i: row(regionId, date)?.installationSlots ?? 0 };
  const set = (regionId: string, date: string, field: "s" | "i", v: number) => {
    setSaved(false);
    setEdits({ ...edits, [key(regionId, date)]: { ...value(regionId, date), [field]: Math.max(0, Math.min(50, v || 0)) } });
  };
  /** Kopieer de eerste week naar alle volgende weken. */
  const copyFirstWeek = () => {
    const next = { ...edits };
    for (const r of regions) {
      for (let d = 7; d < weeks * 7; d++) {
        const date = addDaysIso(today, d);
        next[key(r.id, date)] = value(r.id, addDaysIso(today, d % 7));
      }
    }
    setEdits(next);
    setSaved(false);
  };
  const save = async () => {
    setError(null);
    try {
      await onSave(Object.entries(edits).map(([k, v]) => {
        const [regionId, date] = k.split("|");
        return { regionId: regionId!, date: date!, surveySlots: v.s, installationSlots: v.i };
      }));
      setEdits({});
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };

  if (!regions.length) return <div className="empty">Er zijn nog geen regio's ingesteld.</div>;
  return (
    <>
      <ErrorBox error={error} />
      {saved && <div className="alert info">Opgeslagen.</div>}
      <div className="row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <label className="checkbox"><input type="checkbox" checked={showWeekend} onChange={(e) => setShowWeekend(e.target.checked)} /> Weekend tonen</label>
        <div className="row">
          <button className="btn small" onClick={copyFirstWeek}>Eerste week kopiëren naar alle weken</button>
          <button className="btn primary" disabled={!Object.keys(edits).length} onClick={() => void save()}>Opslaan ({Object.keys(edits).length})</button>
        </div>
      </div>
      <div className="card flush" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Datum</th>
              {regions.map((r) => <th key={r.id} style={{ textAlign: "center" }}>{r.name}<div style={{ fontWeight: 400 }}>schouw · installatie</div></th>)}
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => (
              <tr key={d}>
                <td style={{ whiteSpace: "nowrap" }}>{weekday(d)}</td>
                {regions.map((r) => {
                  const v = value(r.id, d);
                  const used = row(r.id, d);
                  const changed = !!edits[key(r.id, d)];
                  return (
                    <td key={r.id} style={{ textAlign: "center", background: changed ? "var(--accent-soft)" : undefined }}>
                      <input type="number" min={0} max={50} value={v.s} onChange={(e) => set(r.id, d, "s", Number(e.target.value))} style={{ width: 52 }} aria-label="schouwen" />{" "}
                      <input type="number" min={0} max={50} value={v.i} onChange={(e) => set(r.id, d, "i", Number(e.target.value))} style={{ width: 52 }} aria-label="installaties" />
                      {used && (used.surveyUsed > 0 || used.installationUsed > 0) && <div className="muted" style={{ fontSize: 11 }}>bezet: {used.surveyUsed} · {used.installationUsed}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
