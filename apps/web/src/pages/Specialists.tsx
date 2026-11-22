import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { SpecialistAvatar, useSpecialists, type SpecialistRow } from "../components/Specialist";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { formatDate } from "../format";

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

/** Dashboard manager klantenservice (B81): bezetting per klantspecialist, maximum instellen, klanten overzetten. */
export function SpecialistsPage() {
  const overview = useSpecialists();
  const [editing, setEditing] = useState<SpecialistRow | null>(null);
  const [transferFrom, setTransferFrom] = useState<SpecialistRow | null>(null);
  if (overview.isLoading) return <Loading />;
  if (!overview.data) return <ErrorBox error={overview.error} />;
  const { specialists, totals, warningAt } = overview.data;
  const active = specialists.filter((s) => s.isActive);

  return (
    <>
      <PageHead
        title="Klantspecialisten"
        sub="Elke klant krijgt bij de getekende order automatisch de specialist met de minste klanten die nog plek heeft. Na de afgeronde installatie gaat de klant naar Service."
      />
      {totals.warning && (
        <div className="alert warning">
          De bezetting is {pct(totals.utilization)} (signaal vanaf {pct(warningAt)}). Tijd om een extra klantspecialist aan te nemen of maxima te verhogen.
        </div>
      )}
      {totals.unassigned > 0 && (
        <div className="alert error">
          {totals.unassigned} klant{totals.unassigned === 1 ? "" : "en"} met een lopend project {totals.unassigned === 1 ? "heeft" : "hebben"} geen klantspecialist. Koppel ze op de klantkaart.
        </div>
      )}
      <div className="tiles">
        <div className="tile"><span>Klanten bij specialisten</span><strong>{totals.customers}</strong></div>
        <div className="tile"><span>Capaciteit</span><strong>{totals.capacity ?? "—"}</strong>{totals.withoutLimit > 0 && <em className="muted">{totals.withoutLimit} zonder maximum</em>}</div>
        <div className="tile"><span>Bezetting</span><strong>{pct(totals.utilization)}</strong></div>
        <div className="tile"><span>Specialisten actief</span><strong>{active.length}</strong></div>
      </div>
      <div className="card flush">
        <table>
          <thead><tr><th>Specialist</th><th className="num">Klanten</th><th>Bezetting</th><th>Nieuwe klanten</th><th /></tr></thead>
          <tbody>
            {specialists.map((s) => (
              <tr key={s.id} style={{ opacity: s.isActive ? 1 : 0.5 }}>
                <td>
                  <span className="with-avatar">
                    <SpecialistAvatar id={s.id} name={s.name} hasPhoto={s.hasPhoto} size={30} />
                    <span>
                      <strong>{s.name}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>{s.email}{!s.hasPhoto && " · geen pasfoto"}</div>
                    </span>
                  </span>
                </td>
                <td className="num">{s.customers}{s.maxCustomers ? ` / ${s.maxCustomers}` : ""}</td>
                <td style={{ minWidth: 140 }}>
                  {s.utilization == null ? <span className="muted">geen maximum</span> : <Meter value={s.utilization} warnAt={warningAt} />}
                </td>
                <td>{!s.isActive ? <span className="badge">Inactief</span> : s.acceptsNewCustomers ? <span className="badge green">Aan</span> : <span className="badge yellow">Uit (afwezig)</span>}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn small" onClick={() => setEditing(s)}>Instellen</button>{" "}
                  <button className="btn small" disabled={!s.customers} onClick={() => setTransferFrom(s)}>Overzetten</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!specialists.length && <div className="empty">Nog geen klantspecialisten. Geef gebruikers de rol "Klantspecialist" bij Gebruikers.</div>}
      </div>
      {editing && <EditSpecialist s={editing} onClose={() => setEditing(null)} />}
      {transferFrom && <Transfer from={transferFrom} all={active} onClose={() => setTransferFrom(null)} />}
    </>
  );
}

function Meter({ value, warnAt }: { value: number; warnAt: number }) {
  const color = value >= 1 ? "var(--danger)" : value >= warnAt ? "var(--accent)" : "var(--success)";
  return (
    <span className="meter" title={pct(value)}>
      <span className="track"><span className="fill" style={{ width: `${Math.min(100, value * 100)}%`, background: color }} /></span>
      <em>{pct(value)}</em>
    </span>
  );
}

function EditSpecialist({ s, onClose }: { s: SpecialistRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [max, setMax] = useState(s.maxCustomers?.toString() ?? "");
  const [accepts, setAccepts] = useState(s.acceptsNewCustomers);
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/specialists/${s.id}`, { maxCustomers: max.trim() ? Number(max) : null, acceptsNewCustomers: accepts }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["specialists"] });
      onClose();
    },
  });
  return (
    <Modal title={s.name} onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Maximum aantal lopende klanten (leeg = geen maximum)">
        <input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} />
      </Field>
      <label className="row" style={{ gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={accepts} onChange={(e) => setAccepts(e.target.checked)} /> Krijgt automatisch nieuwe klanten (uitzetten bij afwezigheid)
      </label>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <SpecialistAvatar id={s.id} name={s.name} hasPhoto={s.hasPhoto} size={48} />
        <span className="muted" style={{ fontSize: 13 }}>De profielfoto maakt de specialist zelf als selfie (verplicht bij het inloggen); die kan hier niet worden gewijzigd.</span>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Opslaan</button>
      </div>
    </Modal>
  );
}

interface OwnCustomer { id: string; number: number; firstName: string | null; lastName: string; assignedAt: string | null }

function Transfer({ from, all, onClose }: { from: SpecialistRow; all: SpecialistRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["specialist-customers", from.id], queryFn: () => api.get<OwnCustomer[]>(`/specialists/${from.id}/customers`) });
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [notify, setNotify] = useState(true);
  const ids = selected ? [...selected] : (list.data ?? []).map((c) => c.id);
  const go = useMutation({
    meta: { toast: "Klanten overgezet" },
    mutationFn: () => api.post<{ moved: number }>("/specialists/transfer", { customerIds: ids, toUserId: to, notify }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["specialists"] });
      onClose();
    },
  });
  const toggle = (id: string) => {
    const next = new Set(selected ?? (list.data ?? []).map((c) => c.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <Modal title={`Klanten van ${from.name} overzetten`} onClose={onClose} wide>
      <ErrorBox error={go.error} />
      <Field label="Naar">
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Kies een klantspecialist…</option>
          {all.filter((s) => s.id !== from.id).map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.customers}{s.maxCustomers ? ` / ${s.maxCustomers}` : ""})</option>
          ))}
        </select>
      </Field>
      {list.isLoading ? <Loading /> : (
        <div className="transfer-list">
          {list.data?.map((c) => (
            <label key={c.id} className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={selected ? selected.has(c.id) : true} onChange={() => toggle(c.id)} />
              <Link to={`/klanten/${c.id}`} target="_blank">{[c.firstName, c.lastName].filter(Boolean).join(" ")}</Link>
              <span className="muted" style={{ fontSize: 12 }}>sinds {c.assignedAt ? formatDate(c.assignedAt) : "—"}</span>
            </label>
          ))}
        </div>
      )}
      <label className="row" style={{ gap: 8, marginTop: 8 }}>
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Klanten een bericht sturen met hun nieuwe contactpersoon
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" disabled={!to || !ids.length || go.isPending} onClick={() => go.mutate()}>
          {ids.length} klant{ids.length === 1 ? "" : "en"} overzetten
        </button>
      </div>
    </Modal>
  );
}
