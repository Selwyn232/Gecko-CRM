import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AppointmentsTable, CancelModal, PlanModal } from "./Planning";
import { api, type Appointment, type InvoiceSummary, type JourneyStatus, type ProjectDetail, type QuoteListItem } from "../api";
import { InvoicesTable } from "./Invoices";
import { QuotesTable } from "./Quotes";
import { useAuth } from "../auth";
import { ProjectCalculation } from "../components/Calculation";
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
  const [planType, setPlanType] = useState<"survey" | "installation" | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const appointments = useQuery({
    queryKey: ["appointments", "project", id],
    queryFn: () => api.get<Appointment[]>(`/appointments?projectId=${id}`),
    enabled: can("planning.read"),
  });
  const invoices = useQuery({
    queryKey: ["invoices", "project", id],
    queryFn: () => api.get<InvoiceSummary[]>(`/invoices?projectId=${id}`),
    enabled: can("invoices.read"),
    refetchInterval: 10_000,
  });
  const makeInvoice = useMutation({
    mutationFn: (type: "deposit" | "final") => api.post(`/projects/${id}/invoices`, { type }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });
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
      {can("planning.read") && (
        <div className="card flush">
          <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
            <h2 style={{ margin: 0 }}>Afspraken</h2>
            {can("planning.manage") && (
              <div className="row">
                <button className="btn small" onClick={() => setPlanType("survey")}>Schouw plannen</button>
                <button className="btn small" onClick={() => setPlanType("installation")}>Installatie plannen</button>
              </div>
            )}
          </div>
          {!appointments.data?.length ? <div className="empty">Nog geen afspraken.</div> : <AppointmentsTable items={appointments.data} onCancel={can("planning.manage") ? setCancelling : undefined} />}
        </div>
      )}
      {planType && <PlanModal projectId={p.id} type={planType} title={`${planType === "survey" ? "Schouw" : "Installatie"} plannen`} onClose={() => setPlanType(null)} />}
      {cancelling && <CancelModal appointment={cancelling} onClose={() => setCancelling(null)} />}
      {can("quotes.read") && quotes.data && quotes.data.length > 0 && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Offertes</h2></div>
          <QuotesTable items={quotes.data} showCustomer={false} />
        </div>
      )}
      {can("invoices.read") && (
        <div className="card flush">
          <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
            <h2 style={{ margin: 0 }}>Facturen</h2>
            {can("invoices.manage") && (
              <div className="row">
                <button className="btn small" onClick={() => makeInvoice.mutate("deposit")}>Aanbetalingsfactuur maken</button>
                <button className="btn small" onClick={() => makeInvoice.mutate("final")}>Eindfactuur maken</button>
              </div>
            )}
          </div>
          <ErrorBox error={makeInvoice.error} />
          {!invoices.data?.length ? (
            <div className="empty">Nog geen facturen. De aanbetalingsfactuur gaat automatisch zodra het project de status met factuurmoment bereikt (zie Klantreizen).</div>
          ) : (
            <InvoicesTable items={invoices.data} showCustomer={false} />
          )}
        </div>
      )}
      {can("purchase_prices.read") && <ProjectCalculation projectId={p.id} />}

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
