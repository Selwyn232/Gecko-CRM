import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Loading, PageHead } from "../components/ui";

interface Checklist { items: { id?: string; label: string; required: boolean }[]; minPhotos: number }
interface GroupChecklists { productGroup: { id: string; name: string; isActive: boolean }; survey: Checklist; installation: Checklist }

const TYPES = { survey: "Schouwrapport", installation: "Opleverrapport" } as const;

export function ChecklistsPage() {
  const data = useQuery({ queryKey: ["checklists"], queryFn: () => api.get<GroupChecklists[]>("/checklists") });
  const [gid, setGid] = useState<string | null>(null);
  if (data.isLoading) return <Loading />;
  if (!data.data) return <ErrorBox error={data.error} />;
  const groups = data.data.filter((g) => g.productGroup.isActive);
  const g = groups.find((x) => x.productGroup.id === gid) ?? groups[0];
  if (!g) return <div className="empty">Geen productgroepen.</div>;
  return (
    <>
      <PageHead
        title="Checklists"
        sub="Wat de installateur bij de schouw en de oplevering moet controleren, per productgroep. Verplichte punten en het minimum aantal foto's gelden bij een positief rapport."
      />
      <div className="tabs">
        {groups.map((x) => (
          <button key={x.productGroup.id} className={x.productGroup.id === g.productGroup.id ? "active" : ""} onClick={() => setGid(x.productGroup.id)}>{x.productGroup.name}</button>
        ))}
      </div>
      <div className="grid-2">
        {(Object.keys(TYPES) as (keyof typeof TYPES)[]).map((t) => (
          <ChecklistEditor key={`${g.productGroup.id}-${t}`} groupId={g.productGroup.id} type={t} initial={g[t]} />
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Wijzigingen gelden voor nieuwe rapporten; ingediende rapporten houden de punten zoals ze toen waren.</p>
    </>
  );
}

function ChecklistEditor({ groupId, type, initial }: { groupId: string; type: keyof typeof TYPES; initial: Checklist }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can("journeys.manage");
  const [items, setItems] = useState(initial.items.map((i) => ({ label: i.label, required: i.required })));
  const [minPhotos, setMinPhotos] = useState(initial.minPhotos);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [items, minPhotos]);
  const save = useMutation({
    mutationFn: () => api.put(`/checklists/${groupId}/${type}`, { items: items.filter((i) => i.label.trim()), minPhotos }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["checklists"] });
      setSaved(true);
    },
  });
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setItems(next);
  };
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{TYPES[type]}</h2>
      <ErrorBox error={save.error} />
      {items.map((it, i) => (
        <div key={i} className="row" style={{ marginBottom: 6, flexWrap: "nowrap" }}>
          <input style={{ flex: 1, minWidth: 0 }} value={it.label} disabled={!manage} maxLength={200} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <label className="row" style={{ gap: 4, fontSize: 13, whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={it.required} disabled={!manage} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> verplicht
          </label>
          {manage && (
            <>
              <button className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Omhoog">↑</button>
              <button className="btn small" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Omlaag">↓</button>
              <button className="btn small danger" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Verwijderen">✕</button>
            </>
          )}
        </div>
      ))}
      {!items.length && <p className="muted">Nog geen punten.</p>}
      {manage && <button className="btn small" onClick={() => setItems([...items, { label: "", required: false }])}>+ Punt toevoegen</button>}
      <div className="row" style={{ marginTop: 16 }}>
        <label className="row" style={{ gap: 6 }}>
          Minimaal aantal foto's
          <input type="number" min={0} max={30} style={{ width: 70 }} value={minPhotos} disabled={!manage} onChange={(e) => setMinPhotos(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
        </label>
        {manage && <button className="btn primary" style={{ marginLeft: "auto" }} disabled={save.isPending} onClick={() => save.mutate()}>Opslaan</button>}
        {saved && <span className="badge green">Opgeslagen</span>}
      </div>
    </div>
  );
}
