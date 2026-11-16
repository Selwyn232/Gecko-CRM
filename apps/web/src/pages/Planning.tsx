import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Appointment, type Report, type ToPlanItem } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { addDaysIso, APPOINTMENT_STATUS, APPOINTMENT_TYPE, daysSince, formatDateTime, REPORT_REVIEW, TIME_WINDOW, todayIso, weekday } from "../format";
import { useOrganizations } from "../hooks";

type Tab = "survey" | "installation" | "agenda" | "reports";

export function PlanningPage() {
  const [tab, setTab] = useState<Tab>("survey");
  const reports = useQuery({ queryKey: ["reports", "pending"], queryFn: () => api.get<Report[]>("/reports?review=pending") });
  return (
    <>
      <PageHead title="Planning" sub="Schouwen en installaties inplannen op de opgegeven beschikbaarheid van installatiepartners." />
      <div className="tabs">
        <button className={tab === "survey" ? "active" : ""} onClick={() => setTab("survey")}>Schouw te plannen</button>
        <button className={tab === "installation" ? "active" : ""} onClick={() => setTab("installation")}>Installatie te plannen</button>
        <button className={tab === "agenda" ? "active" : ""} onClick={() => setTab("agenda")}>Agenda</button>
        <button className={tab === "reports" ? "active" : ""} onClick={() => setTab("reports")}>Rapporten {reports.data?.length ? <span className="badge yellow">{reports.data.length}</span> : null}</button>
      </div>
      {(tab === "survey" || tab === "installation") && <ToPlan type={tab} />}
      {tab === "agenda" && <Agenda />}
      {tab === "reports" && <PendingReports reports={reports.data} />}
    </>
  );
}

function ToPlan({ type }: { type: "survey" | "installation" }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ["to-plan", type], queryFn: () => api.get<ToPlanItem[]>(`/planning/to-plan?type=${type}`) });
  const [planning, setPlanning] = useState<ToPlanItem | null>(null);
  if (list.isLoading) return <Loading />;
  return (
    <div className="card flush">
      {!list.data?.length ? <div className="empty">Niets te plannen.</div> : (
        <table>
          <thead><tr><th>Project</th><th>Klant</th><th>Plaats</th><th>Productgroep</th><th>Status</th><th className="num">Wacht (dagen)</th><th /></tr></thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.projectId}>
                <td className="mono"><Link to={`/projecten/${p.projectId}`}>{p.projectNumber}</Link></td>
                <td>{p.customerName}</td>
                <td>{p.postalCode.replace(/^(\d{4})/, "$1 ")} {p.city}</td>
                <td>{p.productGroupName}</td>
                <td className="muted">{p.statusName}</td>
                <td className="num">{daysSince(p.waitingSince)}</td>
                <td className="num">{can("planning.manage") && <button className="btn small primary" onClick={() => setPlanning(p)}>Plannen</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {planning && <PlanModal projectId={planning.projectId} type={type} title={`${APPOINTMENT_TYPE[type]} plannen — ${planning.customerName}`} onClose={() => setPlanning(null)} />}
    </div>
  );
}

interface Slot {
  date: string;
  partnerId: string;
  partnerName: string;
  regionId: string;
  free: number;
  days: number;
}

export function PlanModal({ projectId, type, title, onClose }: { projectId: string; type: "survey" | "installation"; title: string; onClose: () => void }) {
  const qc = useQueryClient();
  const slots = useQuery({ queryKey: ["slots", projectId, type], queryFn: () => api.get<{ slots: Slot[]; message: string | null }>(`/planning/slots?projectId=${projectId}&type=${type}`) });
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [timeWindow, setTimeWindow] = useState("day");
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/appointments`, { type, date: chosen!.date, partnerId: chosen!.partnerId, regionId: chosen!.regionId, timeWindow, notes: notes || null }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onClose();
    },
  });
  const byDate = new Map<string, Slot[]>();
  for (const s of slots.data?.slots ?? []) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);

  return (
    <Modal title={title} onClose={onClose}>
      <ErrorBox error={slots.error ?? save.error} />
      {slots.isLoading ? <Loading /> : slots.data?.message ? <div className="alert warning">{slots.data.message}</div> : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Kies een dag en partner met vrije capaciteit{slots.data?.slots[0]?.days && slots.data.slots[0].days > 1 ? ` (installatie duurt ${slots.data.slots[0].days} dagen)` : ""}. De klant krijgt automatisch een bevestiging per e-mail.</p>
          <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 12 }}>
            {[...byDate.entries()].map(([date, list]) => (
              <div key={date} style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
                <strong style={{ fontSize: 13 }}>{weekday(date)}</strong>
                <div className="row" style={{ marginTop: 4 }}>
                  {list.map((s) => (
                    <button key={s.partnerId + s.regionId} className={`btn small ${chosen === s ? "primary" : ""}`} onClick={() => setChosen(s)}>
                      {s.partnerName} <span className="muted">({s.free} vrij)</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="grid-2">
            <Field label="Tijdvak">
              <select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value)}>
                {Object.entries(TIME_WINDOW).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Notitie voor partner"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
        </>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" disabled={!chosen || save.isPending} onClick={() => save.mutate()}>
          {chosen ? `Inplannen op ${weekday(chosen.date)}` : "Kies een moment"}
        </button>
      </div>
    </Modal>
  );
}

export function AppointmentsTable({ items, onCancel }: { items: Appointment[]; onCancel?: (a: Appointment) => void }) {
  const navigate = useNavigate();
  return (
    <table>
      <thead><tr><th>Datum</th><th>Soort</th><th>Project</th><th>Klant / adres</th><th>Partner</th><th>Status</th><th>Rapport</th>{onCancel && <th />}</tr></thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id}>
            <td style={{ whiteSpace: "nowrap" }}>{weekday(a.date)}{a.days > 1 && <span className="muted"> +{a.days - 1}d</span>}<div className="muted" style={{ fontSize: 12 }}>{TIME_WINDOW[a.timeWindow]}</div></td>
            <td>{APPOINTMENT_TYPE[a.type]}</td>
            <td className="mono"><Link to={`/projecten/${a.projectId}`}>{a.projectNumber}</Link></td>
            <td>{[a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ")}<div className="muted" style={{ fontSize: 12 }}>{a.address}</div></td>
            <td>{a.partnerName}</td>
            <td><span className={`status ${APPOINTMENT_STATUS[a.status]!.color}`}>{APPOINTMENT_STATUS[a.status]!.label}</span></td>
            <td>{a.report ? <button className="btn small" onClick={() => navigate(`/rapporten/${a.report!.id}`)}>{REPORT_REVIEW[a.report.review]!.label}</button> : <span className="muted">—</span>}</td>
            {onCancel && <td className="num">{a.status === "planned" && <button className="btn small danger" onClick={() => onCancel(a)}>Annuleren</button>}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Agenda() {
  const { can } = useAuth();
  const orgs = useOrganizations();
  const [partnerId, setPartnerId] = useState("");
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const from = addDaysIso(todayIso(), -7);
  const to = addDaysIso(todayIso(), 42);
  const list = useQuery({
    queryKey: ["appointments", from, to, partnerId],
    queryFn: () => api.get<Appointment[]>(`/appointments?from=${from}&to=${to}${partnerId ? `&partnerId=${partnerId}` : ""}`),
  });
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          <option value="">Alle partners</option>
          {orgs.data?.filter((o) => o.type === "installation_partner").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <span className="muted">Afgelopen week tot 6 weken vooruit</span>
      </div>
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.length ? <div className="empty">Geen afspraken.</div> : <AppointmentsTable items={list.data} onCancel={can("planning.manage") ? setCancelling : undefined} />}
      </div>
      {cancelling && <CancelModal appointment={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}

export function CancelModal({ appointment, onClose }: { appointment: Appointment; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [noShow, setNoShow] = useState(false);
  const [notify, setNotify] = useState(true);
  const save = useMutation({
    mutationFn: () => api.post(`/appointments/${appointment.id}/cancel`, { reason, partnerNoShow: noShow, notifyCustomer: notify }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onClose();
    },
  });
  return (
    <Modal title={`${APPOINTMENT_TYPE[appointment.type]} op ${weekday(appointment.date)} annuleren`} onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Reden"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <label className="checkbox"><input type="checkbox" checked={noShow} onChange={(e) => setNoShow(e.target.checked)} /> De partner is niet gekomen (wordt bijgehouden voor sancties)</label>
      <label className="checkbox"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Klant per e-mail informeren</label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Terug</button>
        <button className="btn danger" disabled={reason.length < 3 || save.isPending} onClick={() => save.mutate()}>Annuleren</button>
      </div>
    </Modal>
  );
}

function PendingReports({ reports }: { reports: Report[] | undefined }) {
  const navigate = useNavigate();
  if (!reports) return <Loading />;
  return (
    <div className="card flush">
      {!reports.length ? <div className="empty">Geen rapporten te beoordelen.</div> : (
        <table>
          <thead><tr><th>Ingediend</th><th>Soort</th><th>Project</th><th>Klant</th><th>Partner</th><th>Uitkomst</th></tr></thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => navigate(`/rapporten/${r.id}`)}>
                <td>{formatDateTime(r.submittedAt)}</td>
                <td>{r.type === "survey" ? "Schouwrapport" : "Opleverrapport"}</td>
                <td className="mono">{r.appointment.projectNumber}</td>
                <td>{[r.appointment.customer.firstName, r.appointment.customer.lastName].filter(Boolean).join(" ")}</td>
                <td>{r.appointment.partnerName}</td>
                <td>{r.positive ? <span className="status green">{r.type === "survey" ? "Haalbaar" : "Werkt"}</span> : <span className="status red">{r.type === "survey" ? "Niet haalbaar" : "Werkt niet"}</span>}{r.data.extraWork?.length ? <span className="badge yellow" style={{ marginLeft: 6 }}>Meerwerk</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
