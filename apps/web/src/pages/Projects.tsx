import { WithAvatar } from "../components/Avatar";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Paged, type ProjectListItem } from "../api";
import { Loading, PageHead, StatusPill } from "../components/ui";
import { customerName, daysSince, formatAddress } from "../format";
import { nameById, useJourneys, useOrganizations, useProductGroups } from "../hooks";

export function ProjectsPage() {
  const navigate = useNavigate();
  const groups = useProductGroups();
  const journeys = useJourneys();
  const orgs = useOrganizations();
  const [groupId, setGroupId] = useState("");
  const [phase, setPhase] = useState("");
  const [statusId, setStatusId] = useState("");
  const [search, setSearch] = useState("");
  const [includeFinal, setIncludeFinal] = useState(false);

  const params = new URLSearchParams({ limit: "100" });
  if (groupId) params.set("productGroupId", groupId);
  if (phase) params.set("phase", phase);
  if (statusId) params.set("statusId", statusId);
  if (search) params.set("search", search);
  if (includeFinal) params.set("includeFinal", "true");
  const list = useQuery({ queryKey: ["projects", params.toString()], queryFn: () => api.get<Paged<ProjectListItem>>(`/projects?${params}`) });

  const statuses = (journeys.data ?? []).filter((j) => !groupId || j.productGroup.id === groupId).flatMap((j) => j.statuses.map((s) => ({ ...s, channelName: j.salesChannel?.name ?? null })));
  const phases = [...new Set(statuses.map((s) => s.phase))];
  const openByPhase = (p: string) => statuses.filter((s) => s.phase === p && !s.isFinal).reduce((n, s) => n + (s.projectCount ?? 0), 0);

  return (
    <>
      <PageHead title="Projecten" sub="Alle lopende projecten, per fase van de klantreis." actions={<a className="btn" href="/api/exports/projecten.csv">Exporteren (CSV)</a>} />
      <div className="phase-strip">
        <button className={!phase ? "active" : ""} onClick={() => { setPhase(""); setStatusId(""); }}>Alle fasen</button>
        {phases.map((p) => (
          <button key={p} className={phase === p ? "active" : ""} onClick={() => { setPhase(p); setStatusId(""); }}>
            {p}<span className="count">{openByPhase(p)}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Zoek op klant, postcode of nummer" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 260 }} />
        <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setStatusId(""); }}>
          <option value="">Alle productgroepen</option>
          {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {groupId && (
          <select value={statusId} onChange={(e) => setStatusId(e.target.value)}>
            <option value="">Alle statussen</option>
            {statuses.filter((s) => !phase || s.phase === phase).map((s) => <option key={s.id} value={s.id}>{s.name}{s.channelName ? ` · ${s.channelName}` : ""} ({s.projectCount ?? 0})</option>)}
          </select>
        )}
        <label className="checkbox"><input type="checkbox" checked={includeFinal} onChange={(e) => setIncludeFinal(e.target.checked)} /> Ook afgeronde/geannuleerde</label>
      </div>
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <div className="empty">Geen projecten gevonden. Maak een project aan vanuit een klant.</div> : (
          <table>
            <thead><tr><th>Nr.</th><th>Klant</th><th>Adres</th><th>Productgroep</th><th>Status</th><th>Partner</th><th className="num">Dagen in status</th></tr></thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/projecten/${p.id}`)}>
                  <td className="mono">{p.displayNumber}</td>
                  <td><strong>{customerName(p.customer)}</strong></td>
                  <td>{formatAddress(p.property)}</td>
                  <td>{nameById(groups.data, p.productGroupId)}</td>
                  <td><StatusPill status={p.status} /></td>
                  <td>{p.installationPartnerId ? <WithAvatar name={nameById(orgs.data, p.installationPartnerId)} size={22} /> : <span className="muted">—</span>}</td>
                  <td className="num">{daysSince(p.statusChangedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {list.data && list.data.total > list.data.items.length && <p className="muted">{list.data.items.length} van {list.data.total} getoond; verfijn de zoekopdracht.</p>}
    </>
  );
}
