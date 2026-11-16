import { useState } from "react";
import { NlMap } from "./NlMap";
import { ErrorBox } from "./ui";

interface RegionOption {
  id: string;
  name: string;
  mapCode: string | null;
  postalRanges: [number, number][];
}

/**
 * Werkgebied: op de kaart van Nederland (200 gebieden) aanklikken in welke gebieden een partner werkt.
 * Eventuele zelf gemaakte regio's (zonder kaartgebied) staan als knoppen onder de kaart.
 */
export function WorkArea({ regions, selected, onSave }: { regions: RegionOption[]; selected: string[]; onSave: (regionIds: string[]) => Promise<unknown> }) {
  const [value, setValue] = useState<string[]>(selected);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const dirty = value.slice().sort().join() !== selected.slice().sort().join();
  const byCode = new Map(regions.filter((r) => r.mapCode).map((r) => [r.mapCode!, r]));
  const selectedCodes = new Set(regions.filter((r) => r.mapCode && value.includes(r.id)).map((r) => r.mapCode!));
  const custom = regions.filter((r) => !r.mapCode);
  const set = (id: string, on: boolean) => {
    setSaved(false);
    setValue((cur) => (on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)));
  };
  // Zoeken op plaatsnaam of postcode (4 cijfers).
  const q = search.trim().toLowerCase();
  const pc = /^\d{4}/.test(q) ? Number(q.slice(0, 4)) : null;
  const matches = q.length >= 2
    ? regions.filter((r) => (pc !== null ? r.postalRanges.some(([a, b]) => pc >= a && pc <= b) : r.name.toLowerCase().includes(q))).slice(0, 8)
    : [];

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Werkgebied <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>({value.length} gebieden)</span></h2>
        <div className="row">
          {dirty && <button className="btn small" onClick={() => setValue(selected)}>Ongedaan maken</button>}
          <button className="btn small primary" disabled={!dirty} onClick={async () => {
            setError(null);
            try {
              await onSave(value);
              setSaved(true);
            } catch (e) {
              setError(e);
            }
          }}>Opslaan</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {saved && !dirty && <div className="alert info">Werkgebied opgeslagen.</div>}
      <p className="muted" style={{ fontSize: 13 }}>Klik op een gebied om het aan of uit te zetten, of houd ingedrukt en veeg over meerdere gebieden. Scroll of gebruik + en − om in te zoomen.</p>
      <div style={{ position: "relative", marginBottom: 8 }}>
        <input placeholder="Zoek plaats of postcode…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "100%" }} />
        {matches.length > 0 && (
          <div className="nlmap-search">
            {matches.map((r) => (
              <button key={r.id} type="button" onClick={() => { set(r.id, !value.includes(r.id)); setSearch(""); }}>
                {value.includes(r.id) ? "✓ " : "+ "}{r.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <NlMap
        selected={selectedCodes}
        onToggle={(code, on) => {
          const r = byCode.get(code);
          if (r) set(r.id, on);
        }}
      />
      {custom.length > 0 && (
        <>
          <div className="field" style={{ marginTop: 12 }}>Overige regio's</div>
          <div className="row">
            {custom.map((r) => {
              const on = value.includes(r.id);
              return <button key={r.id} type="button" className={`btn small ${on ? "primary" : ""}`} onClick={() => set(r.id, !on)}>{on ? "✓ " : ""}{r.name}</button>;
            })}
          </div>
        </>
      )}
    </div>
  );
}
