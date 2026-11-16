import { useState } from "react";
import { ErrorBox } from "./ui";

/** Werkgebied: de regio's waarin een partner werkt. */
export function WorkArea({
  regions,
  selected,
  onSave,
}: {
  regions: { id: string; name: string; postalRanges: [number, number][] }[];
  selected: string[];
  onSave: (regionIds: string[]) => Promise<unknown>;
}) {
  const [value, setValue] = useState<string[]>(selected);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const dirty = value.slice().sort().join() !== selected.slice().sort().join();
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Werkgebied</h2>
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
      <ErrorBox error={error} />
      {saved && !dirty && <div className="alert info">Werkgebied opgeslagen.</div>}
      {!regions.length ? <p className="muted">Er zijn nog geen regio's ingesteld door Gecko.</p> : (
        <div className="row">
          {regions.map((r) => {
            const on = value.includes(r.id);
            return (
              <button
                key={r.id}
                className={`btn small ${on ? "primary" : ""}`}
                onClick={() => { setSaved(false); setValue(on ? value.filter((x) => x !== r.id) : [...value, r.id]); }}
                title={r.postalRanges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(", ")}
              >
                {on ? "✓ " : ""}{r.name}
              </button>
            );
          })}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Gecko plant alleen afspraken binnen uw werkgebied, in de blokken die u beschikbaar zet.</p>
    </div>
  );
}
