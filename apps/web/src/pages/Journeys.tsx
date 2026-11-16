import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type JourneyStatus } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, PageHead, StatusPill } from "../components/ui";
import { JOURNEY_EVENTS } from "../format";
import { useJourneys, useProductGroups } from "../hooks";

const INVOICE_TRIGGERS: Record<string, string> = { deposit: "Aanbetaling", final: "Eindfactuur" };
const COLORS: Record<string, string> = { gray: "Grijs", blue: "Blauw", green: "Groen", yellow: "Geel", red: "Rood", purple: "Paars" };

export function JourneysPage() {
  const { can } = useAuth();
  const journeys = useJourneys();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [editing, setEditing] = useState<JourneyStatus | "new" | null>(null);

  if (journeys.isLoading) return <Loading />;
  const current = journeys.data?.find((j) => j.productGroup.id === groupId) ?? journeys.data?.[0];
  if (!current) return <div className="empty">Geen productgroepen.</div>;
  const statuses = current.statuses;
  const name = (id: string) => statuses.find((s) => s.id === id)?.name ?? "?";
  const manage = can("journeys.manage");

  return (
    <>
      <PageHead
        title="Klantreizen"
        sub="Per productgroep: de statussen van een project en welke overgangen zijn toegestaan. De e-mail aan de klant per status stel je in bij Klantberichten."
        actions={manage && <button className="btn primary" onClick={() => setEditing("new")}>Nieuwe status</button>}
      />
      <div className="tabs">
        {journeys.data!.map((j) => (
          <button key={j.productGroup.id} className={j.productGroup.id === current.productGroup.id ? "active" : ""} onClick={() => setGroupId(j.productGroup.id)}>
            {j.productGroup.name}
          </button>
        ))}
      </div>
      <InstallationDays groupId={current.productGroup.id} />
      <div className="card flush">
        <table>
          <thead><tr><th>Fase</th><th>Status</th><th>Mag door naar</th><th>Automatisch bij</th><th>Factuur</th><th className="num">Projecten</th></tr></thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.id} className={manage ? "clickable" : ""} onClick={() => manage && setEditing(s)} style={{ opacity: s.isActive ? 1 : 0.5 }}>
                <td className="muted">{s.phase}</td>
                <td>
                  <StatusPill status={s} />
                  {s.isInitial && <span className="badge green" style={{ marginLeft: 6 }}>Start</span>}
                  {s.isFinal && <span className="badge" style={{ marginLeft: 6 }}>Eind</span>}
                  {!s.isActive && <span className="badge" style={{ marginLeft: 6 }}>Inactief</span>}
                </td>
                <td style={{ fontSize: 13 }}>{s.nextStatusIds?.length ? s.nextStatusIds.map(name).join(", ") : <span className="muted">—</span>}</td>
                <td style={{ fontSize: 12 }}>{s.autoOnEvents?.length ? s.autoOnEvents.map((e) => JOURNEY_EVENTS[e] ?? e).join(", ") : <span className="muted">—</span>}</td>
                <td>{s.invoiceTrigger ? <span className="badge green">{INVOICE_TRIGGERS[s.invoiceTrigger]}</span> : <span className="muted">—</span>}</td>
                <td className="num">{s.projectCount ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <StatusForm
          productGroupId={current.productGroup.id}
          status={editing === "new" ? undefined : editing}
          all={statuses}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function StatusForm({ productGroupId, status, all, onClose }: { productGroupId: string; status?: JourneyStatus; all: JourneyStatus[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    key: status?.key ?? "",
    name: status?.name ?? "",
    phase: status?.phase ?? "",
    color: status?.color ?? "gray",
    sortOrder: status?.sortOrder ?? (Math.max(0, ...all.map((s) => s.sortOrder)) + 10),
    isInitial: status?.isInitial ?? false,
    isFinal: status?.isFinal ?? false,
    isActive: status?.isActive ?? true,
    invoiceTrigger: status?.invoiceTrigger ?? "",
    autoOnEvents: status?.autoOnEvents ?? [],
  });
  const [next, setNext] = useState<string[]>(status?.nextStatusIds ?? []);
  const phases = [...new Set(all.map((s) => s.phase))];
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ["journeys"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: async () => {
      const { key, invoiceTrigger, ...other } = form;
      const rest = { ...other, invoiceTrigger: invoiceTrigger || null };
      const saved = status
        ? await api.patch<JourneyStatus>(`/journey-statuses/${status.id}`, rest)
        : await api.post<JourneyStatus>(`/journeys/${productGroupId}/statuses`, { key, ...rest });
      await api.put(`/journey-statuses/${saved.id}/transitions`, { toStatusIds: form.isFinal ? [] : next });
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/journey-statuses/${status!.id}`), onSuccess: done });

  return (
    <Modal title={status ? `Status: ${status.name}` : "Nieuwe status"} onClose={onClose}>
      <ErrorBox error={save.error ?? remove.error} />
      <div className="grid-2">
        <Field label="Naam"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Sleutel (voor automatiseringen)"><input className="mono" value={form.key} disabled={!!status} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="bv. netbeheerder_aanmelden" /></Field>
        <Field label="Fase">
          <input list="phases" value={form.phase} onChange={(e) => setForm({ ...form, phase: e.target.value })} />
          <datalist id="phases">{phases.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Kleur">
          <select value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}>
            {Object.entries(COLORS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Factuur automatisch maken en versturen">
          <select value={form.invoiceTrigger} onChange={(e) => setForm({ ...form, invoiceTrigger: e.target.value })}>
            <option value="">Geen</option>
            <option value="deposit">Aanbetalingsfactuur</option>
            <option value="final">Eindfactuur</option>
          </select>
        </Field>
        <Field label="Automatisch naar deze status bij">
          <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px", maxHeight: 150, overflow: "auto" }}>
            {Object.entries(JOURNEY_EVENTS).map(([k, v]) => (
              <label key={k} className="checkbox" style={{ fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={form.autoOnEvents.includes(k)}
                  onChange={() => setForm({ ...form, autoOnEvents: form.autoOnEvents.includes(k) ? form.autoOnEvents.filter((x) => x !== k) : [...form.autoOnEvents, k] })}
                />
                {v}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Volgorde"><input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} /></Field>
      </div>
      <label className="checkbox"><input type="checkbox" checked={form.isInitial} onChange={(e) => setForm({ ...form, isInitial: e.target.checked })} /> Startstatus voor nieuwe projecten</label>
      <label className="checkbox"><input type="checkbox" checked={form.isFinal} onChange={(e) => setForm({ ...form, isFinal: e.target.checked })} /> Eindstatus (afgerond of geannuleerd)</label>
      <label className="checkbox"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Actief</label>
      {!form.isFinal && (
        <>
          <div className="field" style={{ marginTop: 12 }}>Mag door naar</div>
          <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px" }}>
            {all.filter((s) => s.id !== status?.id).map((s) => (
              <label key={s.id} className="checkbox">
                <input type="checkbox" checked={next.includes(s.id)} onChange={() => setNext(next.includes(s.id) ? next.filter((x) => x !== s.id) : [...next, s.id])} />
                <span><span className="muted">{s.phase} ·</span> {s.name}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="modal-actions">
        {status && !status.isInitial && <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => remove.mutate()}>Verwijderen</button>}
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}

function InstallationDays({ groupId }: { groupId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const groups = useProductGroups();
  const g = groups.data?.find((x) => x.id === groupId);
  const save = useMutation({
    mutationFn: (days: number) => api.patch(`/product-groups/${groupId}`, { installationDays: days }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-groups"] }),
  });
  if (!g) return null;
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <span className="muted">Duur installatie {g.name.toLowerCase()}:</span>
      <input key={g.installationDays} type="number" min={1} max={30} defaultValue={g.installationDays} disabled={!can("catalog.manage")} style={{ width: 70 }} onBlur={(e) => Number(e.target.value) !== g.installationDays && save.mutate(Number(e.target.value))} />
      <span className="muted">werkdag(en)</span>
      <ErrorBox error={save.error} />
    </div>
  );
}
