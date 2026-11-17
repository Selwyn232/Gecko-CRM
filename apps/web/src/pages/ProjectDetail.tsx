import { WithAvatar } from "../components/Avatar";
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
import { customerName, daysSince, formatAddress, formatCents, formatDateTime, PAYMENT_METHODS } from "../format";
import { nameById, useChannels, useJourneys, useOrganizations, useProductGroups, partnersFor } from "../hooks";

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
                  {partnersFor(orgs.data, p.productGroupId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : p.installationPartnerId ? <WithAvatar name={nameById(orgs.data, p.installationPartnerId)} size={22} /> : "Nog niet bekend"}
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
          <ul className="status-history">
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

      {target && target.key === "geannuleerd" && <CancelProjectModal project={p} onClose={() => setTarget(null)} />}
      {target && target.key !== "geannuleerd" && <StatusModal project={p} target={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function StatusModal({ project, target, onClose }: { project: ProjectDetail; target: JourneyStatus; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const save = useMutation({
    meta: { toast: "Status gewijzigd" },
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

interface CancellationPreview {
  projectNumber: string;
  canCancel: boolean;
  reasonIfNot: string | null;
  appointments: { id: string; type: string; date: string }[];
  invoices: { id: string; number: string | null; type: string; status: string; totalCents: number; paidCents: number }[];
  quotes: { id: string; number: string; kind: string }[];
  selfBilling: { number: string | null; kind: string; amountCents: number }[];
}

/** Annuleren in één keer: laat zien wat er gebeurt en laat per factuur kiezen of die wordt gecrediteerd. */
function CancelProjectModal({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const preview = useQuery({ queryKey: ["cancellation", project.id], queryFn: () => api.get<CancellationPreview>(`/projects/${project.id}/cancellation`) });
  const [reason, setReason] = useState("");
  const [credit, setCredit] = useState<string[] | null>(null);
  const chosen = credit ?? preview.data?.invoices.map((i) => i.id) ?? [];
  const cancel = useMutation({
    mutationFn: () => api.post<{ creditNotes: { number: string }[]; refundCents: number; selfBillingToCorrect: unknown[] }>(`/projects/${project.id}/cancel`, { reason, creditInvoiceIds: chosen }),
    onSuccess: async () => {
      await qc.invalidateQueries();
    },
  });
  const d = preview.data;
  const done = cancel.data;
  return (
    <Modal title={`Project ${project.displayNumber} annuleren`} onClose={onClose}>
      <ErrorBox error={preview.error ?? cancel.error} />
      {!d ? <Loading /> : done ? (
        <>
          <div className="alert info">Het project is geannuleerd.</div>
          <ul style={{ paddingLeft: 18 }}>
            {done.creditNotes.length > 0 && <li>Creditnota's: {done.creditNotes.map((c) => c.number).join(", ")}</li>}
            {done.refundCents > 0 && <li><strong>Terugbetalen: {formatCents(done.refundCents)}</strong> (was al betaald). Doe dit handmatig of via Mollie.</li>}
            {done.selfBillingToCorrect.length > 0 && <li>Er is al selfbilling afgerekend voor dit project; corrigeer dat met een correctieregel bij de volgende uitbetaling.</li>}
          </ul>
          <div className="modal-actions"><button className="btn primary" onClick={onClose}>Sluiten</button></div>
        </>
      ) : !d.canCancel ? (
        <div className="alert warning">{d.reasonIfNot}</div>
      ) : (
        <>
          <p>Wat er gebeurt:</p>
          <ul style={{ paddingLeft: 18, marginTop: 0 }}>
            <li>{d.appointments.length ? `${d.appointments.length} geplande afspraak/afspraken vervallen (de installateur ziet ze verdwijnen).` : "Geen geplande afspraken."}</li>
            {d.quotes.length > 0 && <li>Openstaande offertes worden afgewezen: {d.quotes.map((q) => q.number).join(", ")}.</li>}
            <li>Nog niet afgerekende fee en installatie worden niet meer uitbetaald.</li>
            <li>De klant krijgt het bericht "Uw project is geannuleerd" als dat aan staat bij Klantberichten.</li>
          </ul>
          {d.invoices.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="field">Facturen crediteren</div>
              {d.invoices.map((i) => (
                <label key={i.id} className="checkbox">
                  <input
                    type="checkbox"
                    disabled={!can("invoices.manage")}
                    checked={chosen.includes(i.id)}
                    onChange={(e) => setCredit(e.target.checked ? [...chosen, i.id] : chosen.filter((x) => x !== i.id))}
                  />
                  <span>{i.number} ({i.type === "deposit" ? "aanbetaling" : "eindfactuur"}) — {formatCents(i.totalCents)}{i.paidCents > 0 && <strong> · {formatCents(i.paidCents)} al betaald → terugbetalen</strong>}</span>
                </label>
              ))}
            </div>
          )}
          {d.selfBilling.length > 0 && <div className="alert warning">Er is al selfbilling afgerekend voor dit project ({d.selfBilling.map((s) => s.number).join(", ")}); dat moet handmatig worden gecorrigeerd.</div>}
          <Field label="Reden (komt in de historie en op de creditnota)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Terug</button>
            <button className="btn danger" disabled={reason.trim().length < 3 || cancel.isPending} onClick={() => cancel.mutate()}>Project annuleren</button>
          </div>
        </>
      )}
    </Modal>
  );
}
