import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AvailabilityBlock, type Region } from "../api";
import { WorkArea } from "../components/WorkArea";
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
  const [showMap, setShowMap] = useState(false);
  const list = (regions.data ?? []).filter((r) => showMap || !r.mapCode);
  const mapCount = (regions.data ?? []).filter((r) => r.mapCode).length;
  return (
    <>
      <PageHead
        title="Regio's"
        sub="Nederland is standaard verdeeld in 200 kaartgebieden (op postcode). Partners klikken hun werkgebied aan op de kaart. Hier kun je daarnaast eigen regio's maken."
        actions={can("planning.manage") && <button className="btn primary" onClick={() => setEditing("new")}>Nieuwe regio</button>}
      />
      <label className="checkbox" style={{ marginBottom: 8 }}><input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} /> Ook de {mapCount} kaartgebieden tonen</label>
      <div className="card flush">
        {regions.isLoading ? <Loading /> : !list.length ? <div className="empty">Geen eigen regio's. De 200 kaartgebieden worden automatisch gebruikt.</div> : (
          <table>
            <thead><tr><th>Naam</th><th>Postcodegebieden</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className={can("planning.manage") && !r.mapCode ? "clickable" : ""} onClick={() => can("planning.manage") && !r.mapCode && setEditing(r)}>
                  <td><strong>{r.name}</strong>{r.mapCode && <span className="badge" style={{ marginLeft: 6 }}>kaart</span>}</td>
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

/** Werkgebied en beschikbaarheid van partners bekijken en (namens hen) aanpassen. */
export function AvailabilityPage() {
  const orgs = useOrganizations();
  const partners = (orgs.data ?? []).filter((o) => o.type === "installation_partner" && o.isActive);
  const [partnerId, setPartnerId] = useState("");
  const pid = partnerId || partners[0]?.id || "";
  const regions = useQuery({ queryKey: ["regions"], queryFn: () => api.get<Region[]>("/regions") });
  const partnerRegions = useQuery({ queryKey: ["partner-regions", pid], queryFn: () => api.get<string[]>(`/planning/partner-regions/${pid}`), enabled: !!pid });
  const weeks = 8;
  const from = todayIso();
  const qc = useQueryClient();
  const blocks = useQuery({
    queryKey: ["availability", pid, from],
    queryFn: () => api.get<AvailabilityBlock[]>(`/planning/availability?from=${addDaysIso(from, -7)}&to=${addDaysIso(from, weeks * 7 + 7)}&partnerId=${pid}`),
    enabled: !!pid,
  });
  return (
    <>
      <PageHead title="Beschikbaarheid" sub="Werkgebied en beschikbare dagdelen per partner. Partners vullen dit normaal zelf in via hun portaal." />
      {!partners.length ? <div className="empty">Nog geen installatiepartners.</div> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select value={pid} onChange={(e) => setPartnerId(e.target.value)}>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {regions.data && partnerRegions.data && (
            <WorkArea
              key={pid}
              regions={regions.data.filter((r) => r.isActive)}
              selected={partnerRegions.data}
              onSave={async (regionIds) => {
                await api.put(`/planning/partner-regions/${pid}`, { regionIds });
                await qc.invalidateQueries({ queryKey: ["partner-regions", pid] });
              }}
            />
          )}
          {blocks.isLoading ? <Loading /> : (
            <AvailabilityGrid
              key={pid}
              blocks={blocks.data ?? []}
              weeks={weeks}
              onSave={async (changes) => {
                await api.put("/planning/availability", { partnerId: pid, changes });
                await qc.invalidateQueries({ queryKey: ["availability"] });
              }}
            />
          )}
        </>
      )}
    </>
  );
}
