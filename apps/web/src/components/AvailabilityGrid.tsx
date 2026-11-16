import { useState } from "react";
import type { AvailabilityBlock, DayPart } from "../api";
import { addDaysIso, todayIso } from "../format";
import { ErrorBox } from "./ui";

interface Props {
  blocks: AvailabilityBlock[];
  weeks: number;
  onSave: (changes: { date: string; part: DayPart; available: boolean }[]) => Promise<unknown>;
}

const PARTS: { key: DayPart; label: string }[] = [
  { key: "morning", label: "Ochtend" },
  { key: "afternoon", label: "Middag" },
];
const DAY_NAMES = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"];

/** Maandag van de week waarin `iso` valt. */
function mondayOf(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDaysIso(iso, -dow);
}

/**
 * Agenda met aanklikbare blokken: per dag een ochtend- en middagblok.
 * Groen = beschikbaar, grijs = niet beschikbaar, blauw = afspraak (kan niet uit).
 */
export function AvailabilityGrid({ blocks, weeks, onSave }: Props) {
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [showWeekend, setShowWeekend] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const today = todayIso();
  const firstMonday = mondayOf(today);
  const dayCount = showWeekend ? 7 : 5;
  const key = (date: string, part: DayPart) => `${date}|${part}`;
  const block = (date: string, part: DayPart) => blocks.find((b) => b.date === date && b.part === part);
  const isOn = (date: string, part: DayPart) => edits[key(date, part)] ?? !!block(date, part);
  const isBusy = (date: string, part: DayPart) => !!block(date, part)?.appointmentId;
  const editable = (date: string, part: DayPart) => date >= today && !isBusy(date, part);

  const set = (next: Record<string, boolean>) => {
    // Alleen echte wijzigingen bewaren.
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(next)) {
      const [date, part] = k.split("|") as [string, DayPart];
      if (v !== !!block(date, part)) clean[k] = v;
    }
    setEdits(clean);
    setSaved(false);
  };
  const toggle = (date: string, part: DayPart) => editable(date, part) && set({ ...edits, [key(date, part)]: !isOn(date, part) });
  const setDay = (date: string, on: boolean) => {
    const next = { ...edits };
    for (const p of PARTS) if (editable(date, p.key)) next[key(date, p.key)] = on;
    set(next);
  };
  const setWeek = (monday: string, on: boolean) => {
    const next = { ...edits };
    for (let d = 0; d < dayCount; d++) for (const p of PARTS) if (editable(addDaysIso(monday, d), p.key)) next[key(addDaysIso(monday, d), p.key)] = on;
    set(next);
  };
  /** Patroon van deze week overnemen in alle volgende weken. */
  const copyWeek = (monday: string) => {
    const next = { ...edits };
    for (let w = 1; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        for (const p of PARTS) {
          const target = addDaysIso(monday, w * 7 + d);
          if (editable(target, p.key)) next[key(target, p.key)] = isOn(addDaysIso(monday, d), p.key);
        }
      }
    }
    set(next);
  };
  const save = async () => {
    setError(null);
    try {
      await onSave(Object.entries(edits).map(([k, available]) => {
        const [date, part] = k.split("|") as [string, DayPart];
        return { date, part, available };
      }));
      setEdits({});
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };

  const changes = Object.keys(edits).length;
  return (
    <>
      <ErrorBox error={error} />
      {saved && <div className="alert info">Opgeslagen.</div>}
      <div className="row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <div className="row" style={{ fontSize: 13 }}>
          <span className="avail-legend on" /> beschikbaar
          <span className="avail-legend" /> niet beschikbaar
          <span className="avail-legend busy" /> afspraak
          <label className="checkbox" style={{ marginLeft: 12 }}><input type="checkbox" checked={showWeekend} onChange={(e) => setShowWeekend(e.target.checked)} /> Weekend</label>
        </div>
        <div className="row">
          {changes > 0 && <button className="btn" onClick={() => setEdits({})}>Ongedaan maken</button>}
          <button className="btn primary" disabled={!changes} onClick={() => void save()}>Opslaan{changes ? ` (${changes})` : ""}</button>
        </div>
      </div>
      <div className="avail-calendar">
        {Array.from({ length: weeks }, (_, w) => {
          const monday = addDaysIso(firstMonday, w * 7);
          const weekNo = isoWeek(monday);
          return (
            <div key={monday} className="avail-week">
              <div className="avail-week-head">
                <strong>Week {weekNo}</strong>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn small" onClick={() => setWeek(monday, true)}>Hele week aan</button>
                  <button className="btn small" onClick={() => setWeek(monday, false)}>Uit</button>
                  {w < weeks - 1 && <button className="btn small" onClick={() => copyWeek(monday)} title="Dit weekpatroon overnemen in alle volgende weken">Kopieer naar volgende weken</button>}
                </div>
              </div>
              <div className="avail-days" style={{ gridTemplateColumns: `repeat(${dayCount}, 1fr)` }}>
                {Array.from({ length: dayCount }, (_, d) => {
                  const date = addDaysIso(monday, d);
                  const past = date < today;
                  return (
                    <div key={date} className={`avail-day ${past ? "past" : ""}`}>
                      <button className="avail-day-label" disabled={past} onClick={() => setDay(date, !PARTS.every((p) => isOn(date, p.key)))} title="Hele dag aan/uit">
                        {DAY_NAMES[d]} {Number(date.slice(8))}-{Number(date.slice(5, 7))}
                      </button>
                      {PARTS.map((p) => {
                        const busy = isBusy(date, p.key);
                        const on = isOn(date, p.key);
                        const changed = edits[key(date, p.key)] !== undefined;
                        return (
                          <button
                            key={p.key}
                            className={`avail-block ${busy ? "busy" : on ? "on" : ""} ${changed ? "changed" : ""}`}
                            disabled={!editable(date, p.key)}
                            onClick={() => toggle(date, p.key)}
                            aria-pressed={on}
                            aria-label={`${DAY_NAMES[d]} ${date} ${p.label}: ${busy ? "afspraak" : on ? "beschikbaar" : "niet beschikbaar"}`}
                          >
                            {p.label}
                            {busy && <span>{(block(date, p.key)?.capacity ?? 1) > 1 ? `${block(date, p.key)?.appointmentCount}/${block(date, p.key)?.capacity} bezet` : "afspraak"}</span>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function isoWeek(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}
