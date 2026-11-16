import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AvailabilityRow, type Region } from "../api";
import { useAuth } from "../auth";
import { AvailabilityGrid } from "../components/AvailabilityGrid";
import { ActiveBadge, ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { addDaysIso, todayIso } from "../format";
import { useOrganizations } from "../hooks";

const formatRanges = (r: [number, number][]) => r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
function parseRanges(input: string): [number, number][] {
  return input
    .split(/[,\n;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [a, b] = p.split("-").map((x) => Number(x.trim()));
      return [a!, b ?? a!] as [number, number];
    });
}

export function RegionsPage() {
  const { can } = useAuth();
  const regions = useQuery({ queryKey: ["regions"], queryFn: () => api.get<Region[]>("/regions") });
  const [editing, setEditing] = useState<Region | "new" | null>(null);
  return (
    <>
      <PageHead
        title="Regio's"
        sub="Een regio is een set postcodegebieden (eerste 4 cijfers). Partners geven per regio hun beschikbaarheid op."
        actions={can("planning.manage") && <button className="btn primary" onClick={() => setEditing("new")}>Nieuwe regio</button>}
      />
      <div className="card flush">
        {regions.isLoading ? <Loading /> : !regions.data?.length ? <div className="empty">Nog geen regio's.</div> : (
          <table>
            <thead><tr><th>Naam</th><th>Postcodegebieden</th><th>Status</th></tr></thead>
            <tbody>
              {regions.data.map((r) => (
                <tr key={r.id} className={can("planning.manage") ? "clickable" : ""} onClick={() => can("planning.manage") && setEditing(r)}>
                  <td><strong>{r.name}</strong></td>
                  <td className="mono">{formatRanges(r.postalRanges)}</td>
                  <td><ActiveBadge active={r.isActive} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <RegionForm region={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RegionForm({ region, onClose }: { region?: Region; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(region?.name ?? "");
  const [ranges, setRanges] = useState(region ? formatRanges(region.postalRanges) : "");
  const [active, setActive] = useState(region?.isActive ?? true);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, postalRanges: parseRanges(ranges), isActive: active };
      return region ? api.patch(`/regions/${region.id}`, body) : api.post("/regions", body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["regions"] });
      onClose();
    },
  });
  return (
    <Modal title={region ? "Regio wijzigen" : "Nieuwe regio"} onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Noord-Holland Zuid" /></Field>
      <Field label="Postcodegebieden (gescheiden door komma's)">
        <textarea rows={3} className="mono" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1000-1199, 2000-2199, 2131" />
      </Field>
      <label className="checkbox"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Actief</label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={!name || !ranges || save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}

/** Beschikbaarheid van partners bekijken en (namens hen) invullen. */
export function AvailabilityPage() {
  const orgs = useOrganizations();
  const partners = (orgs.data ?? []).filter((o) => o.type === "installation_partner" && o.isActive);
  const [partnerId, setPartnerId] = useState("");
  const pid = partnerId || partners[0]?.id || "";
  const regions = useQuery({ queryKey: ["regions"], queryFn: () => api.get<Region[]>("/regions") });
  const weeks = 8;
  const from = todayIso();
  const to = addDaysIso(from, weeks * 7);
  const qc = useQueryClient();
  const rows = useQuery({
    queryKey: ["availability", pid, from],
    queryFn: () => api.get<AvailabilityRow[]>(`/planning/availability?from=${from}&to=${to}&partnerId=${pid}`),
    enabled: !!pid,
  });
  return (
    <>
      <PageHead title="Beschikbaarheid" sub="Per partner, per dag en regio: aantal schouwen en installaties. Partners vullen dit normaal zelf in via hun portaal." />
      {!partners.length ? <div className="empty">Nog geen installatiepartners.</div> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select value={pid} onChange={(e) => setPartnerId(e.target.value)}>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {rows.isLoading || regions.isLoading ? <Loading /> : (
            <AvailabilityGrid
              key={pid}
              regions={(regions.data ?? []).filter((r) => r.isActive)}
              rows={rows.data ?? []}
              weeks={weeks}
              onSave={async (entries) => {
                await api.put("/planning/availability", { partnerId: pid, entries });
                await qc.invalidateQueries({ queryKey: ["availability"] });
              }}
            />
          )}
        </>
      )}
    </>
  );
}
