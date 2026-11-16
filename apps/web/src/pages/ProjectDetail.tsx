import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type JourneyStatus, type ProjectDetail, type QuoteListItem } from "../api";
import { QuotesTable } from "./Quotes";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, StatusPill } from "../components/ui";
import { customerName, daysSince, formatAddress, formatDateTime, PAYMENT_METHODS } from "../format";
import { nameById, useChannels, useJourneys, useOrganizations, useProductGroups } from "../hooks";

export function ProjectDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const groups = useProductGroups();
  const channels = useChannels();
  const orgs = useOrganizations();
  const journeys = useJourneys();
  const [target, setTarget] = useState<JourneyStatus | null>(null);
  const project = useQuery({ queryKey: ["project", id], queryFn: () => api.get<ProjectDetail>(`/projects/${id}`) });
  const quotes = useQuery({
    queryKey: ["quotes", "project", id],
    queryFn: () => api.get<QuoteListItem[]>(`/quotes?projectId=${id}`),
    enabled: can("quotes.read"),
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/projects/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", id] }),
  });

  if (project.isLoading) return <Loading />;
  if (!project.data) return <ErrorBox error={project.error ?? "Niet gevonden"} />;
  const p = project.data;
  const allStatuses = journeys.data?.find((j) => j.productGroup.id === p.productGroupId)?.statuses ?? [];
  const statusName = (sid: string | null) => (sid ? allStatuses.find((s) => s.id === sid)?.name ?? "—" : "—");
  const manage = can("projects.manage");

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link to="/projecten">← Projecten</Link> · <Link to={`/klanten/${p.customer.id}`}>{customerName(p.customer)}</Link>
      </div>
      <div className="page-head">
        <div>
          <h1>{nameById(groups.data, p.productGroupId)} — {customerName(p.customer)}</h1>
          <p className="row"><span className="mono">{p.displayNumber}</span><span>{formatAddress(p.property)}</span></p>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>Huidige status · {p.status.phase} · {daysSince(p.statusChangedAt)} dag(en)</div>
            <div style={{ marginTop: 4 }}><StatusPill status={p.status} /></div>
          </div>
          {manage && p.nextStatuses.length > 0 && (
            <div className="row">
              {p.nextStatuses.map((s) => (
                <button key={s.id} className={`btn ${s.key === "geannuleerd" ? "danger" : ""}`} onClick={() => setTarget(s)}>
                  → {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Gegevens</h2>
          <ErrorBox error={update.error} />
          <dl className="kv">
            <dt>Verkoopkanaal</dt><dd>{nameById(channels.data, p.salesChannelId)}</dd>
            <dt>Installatiepartner</dt>
            <dd>
              {manage ? (
                <select value={p.installationPartnerId ?? ""} onChange={(e) => update.mutate({ installationPartnerId: e.target.value || null })}>
                  <option value="">Nog niet bekend</option>
                  {orgs.data?.filter((o) => o.type === "installation_partner").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : nameById(orgs.data, p.installationPartnerId)}
            </dd>
            <dt>Betaalwijze</dt>
            <dd>
              {manage ? (
                <select value={p.paymentMethod} onChange={(e) => update.mutate({ paymentMethod: e.target.value })}>
                  {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              ) : PAYMENT_METHODS[p.paymentMethod]}
            </dd>
            <dt>Klant</dt><dd><Link to={`/klanten/${p.customer.id}`}>{customerName(p.customer)}</Link> <span className="muted mono">{p.customer.displayNumber}</span></dd>
            <dt>Contact</dt><dd>{[p.customer.email, p.customer.phone].filter(Boolean).join(" · ") || "—"}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Statushistorie</h2>
          <ul className="timeline">
            {p.history.map((h) => (
              <li key={h.id}>
                <div><strong>{statusName(h.toStatusId)}</strong></div>
                <div className="muted" style={{ fontSize: 13 }}>{formatDateTime(h.changedAt)} · {h.changedByName ?? "Systeem"}{h.fromStatusId && <> · vanuit {statusName(h.fromStatusId)}</>}</div>
                {h.note && <div style={{ fontSize: 13, marginTop: 2 }}>“{h.note}”</div>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {can("quotes.read") && quotes.data && quotes.data.length > 0 && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Offerte</h2></div>
          <QuotesTable items={quotes.data} showCustomer={false} />
        </div>
      )}
      <p className="muted" style={{ fontSize: 13 }}>Facturen, afspraken en communicatie komen in de volgende stappen op deze pagina.</p>

      {target && <StatusModal project={p} target={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function StatusModal({ project, target, onClose }: { project: ProjectDetail; target: JourneyStatus; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => api.post(`/projects/${project.id}/status`, { toStatusId: target.id, expectedStatusId: project.statusId, note: note || null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["project", project.id] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["journeys"] });
      onClose();
    },
  });
  return (
    <Modal title="Status wijzigen" onClose={onClose}>
      <ErrorBox error={save.error} />
      <p><StatusPill status={project.status} /> → <StatusPill status={target} /></p>
      <Field label="Notitie (optioneel)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Wijzigen</button>
      </div>
    </Modal>
  );
}
