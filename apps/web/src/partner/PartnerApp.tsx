import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type Appointment, type AvailabilityBlock, type Penalty, type Region, type Report } from "../api";
import { WorkArea } from "../components/WorkArea";
import { useAuth } from "../auth";
import { AvailabilityGrid } from "../components/AvailabilityGrid";
import { ChangePasswordModal } from "../components/ChangePassword";
import { PhotoGrid, PhotoUpload } from "../components/PhotoUpload";
import { SignaturePad } from "../components/SignaturePad";
import { ErrorBox, Field, Loading, PageHead } from "../components/ui";
import { addDaysIso, APPOINTMENT_STATUS, APPOINTMENT_TYPE, formatCents, formatQty, REPORT_REVIEW, TIME_WINDOW, todayIso, weekday } from "../format";

/** Portaal voor installatiepartners: alleen eigen afspraken, rapporten en beschikbaarheid. */
export function PartnerApp() {
  const { me, logout } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">G</span> Partnerportaal</div>
        <nav className="nav">
          <NavLink to="/afspraken">Afspraken</NavLink>
          <NavLink to="/beschikbaarheid">Beschikbaarheid</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: "var(--text)", fontWeight: 500 }}>{me?.name}</div>
          <div>{me?.organizationName}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setChangingPassword(true)}>Wachtwoord</button>
            <button className="btn small" onClick={logout}>Uitloggen</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/afspraken" replace />} />
          <Route path="/afspraken" element={<PartnerAppointments />} />
          <Route path="/afspraken/:id" element={<PartnerAppointment />} />
          <Route path="/beschikbaarheid" element={<PartnerAvailability />} />
          <Route path="*" element={<Navigate to="/afspraken" replace />} />
        </Routes>
      </main>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
  );
}

function PartnerAppointments() {
  const navigate = useNavigate();
  const from = addDaysIso(todayIso(), -14);
  const to = addDaysIso(todayIso(), 60);
  const list = useQuery({ queryKey: ["partner-appointments"], queryFn: () => api.get<Appointment[]>(`/partner/appointments?from=${from}&to=${to}`) });
  const open = (list.data ?? []).filter((a) => a.status === "planned");
  const todo = open.filter((a) => a.date <= todayIso());
  const penalties = useQuery({ queryKey: ["partner-penalties"], queryFn: () => api.get<Penalty[]>("/partner/penalties") });
  const openPenalties = (penalties.data ?? []).filter((p) => p.status === "open");
  return (
    <>
      <PageHead title="Afspraken" sub="Uw geplande schouwen en installaties. Lever na afloop het rapport in met foto's." />
      {todo.length > 0 && <div className="alert warning">{todo.length} afspraak/afspraken wacht(en) op een rapport.</div>}
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.length ? <div className="empty">Geen afspraken.</div> : (
          <table>
            <thead><tr><th>Datum</th><th>Soort</th><th>Klant / adres</th><th>Status</th><th>Rapport</th></tr></thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate(`/afspraken/${a.id}`)}>
                  <td style={{ whiteSpace: "nowrap" }}>{weekday(a.date)}{a.days > 1 && <span className="muted"> ({a.days} dagen)</span>}<div className="muted" style={{ fontSize: 12 }}>{TIME_WINDOW[a.timeWindow]}</div></td>
                  <td>{APPOINTMENT_TYPE[a.type]} <span className="muted">{a.productGroupName}</span></td>
                  <td>{[a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ")}<div className="muted" style={{ fontSize: 12 }}>{a.address}</div></td>
                  <td><span className={`status ${APPOINTMENT_STATUS[a.status]!.color}`}>{APPOINTMENT_STATUS[a.status]!.label}</span></td>
                  <td>{a.report ? <span className={`status ${REPORT_REVIEW[a.report.review]!.color}`}>{REPORT_REVIEW[a.report.review]!.label}</span> : a.status === "planned" && a.date <= todayIso() ? <span className="badge yellow">Nog indienen</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {openPenalties.length > 0 && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Openstaande sancties</h2></div>
          <table>
            <tbody>
              {openPenalties.map((p) => (
                <tr key={p.id}><td>{p.reason}</td><td className="num">{formatCents(p.amountCents)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ padding: "8px 20px", fontSize: 13 }}>Sancties worden verrekend met uw vergoeding. Vragen? Neem contact op met Gecko.</p>
        </div>
      )}
    </>
  );
}

type PartnerAppointmentDetail = Appointment & {
  scope: { description: string; quantity: string; code: string; kind: string }[];
  extraWorkProducts: { id: string; code: string; name: string; unit: string }[];
  files: { id: string; filename: string; contentType: string }[];
  reportDetail: Report | null;
};

const SURVEY_CHECKS = ["Meterkast beoordeeld", "Locatie apparatuur bepaald", "Kabelroute bepaald", "Klant geïnformeerd over planning"];
const INSTALL_CHECKS = ["Installatie getest en werkend", "Klant uitleg gegeven", "Werkplek opgeruimd", "Aangemeld/geregistreerd waar nodig"];

function PartnerAppointment() {
  const { id } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["partner-appointment", id], queryFn: () => api.get<PartnerAppointmentDetail>(`/partner/appointments/${id}`) });
  if (detail.isLoading) return <Loading />;
  if (!detail.data) return <ErrorBox error={detail.error} />;
  const a = detail.data;
  const canReport = a.status === "planned" && a.date <= todayIso();
  const refresh = () => qc.invalidateQueries({ queryKey: ["partner-appointment", id] });

  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/afspraken">← Afspraken</Link></div>
      <div className="page-head">
        <div>
          <h1>{APPOINTMENT_TYPE[a.type]} {a.productGroupName.toLowerCase()}</h1>
          <p className="row"><span className={`status ${APPOINTMENT_STATUS[a.status]!.color}`}>{APPOINTMENT_STATUS[a.status]!.label}</span><span>{weekday(a.date)} · {TIME_WINDOW[a.timeWindow]}{a.days > 1 ? ` · ${a.days} dagen` : ""}</span></p>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Klant</h2>
          <dl className="kv">
            <dt>Naam</dt><dd>{[a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ")}</dd>
            <dt>Adres</dt><dd><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.address)}`} target="_blank" rel="noreferrer">{a.address}</a></dd>
            <dt>Telefoon</dt><dd>{a.customer.phone ? <a href={`tel:${a.customer.phone}`}>{a.customer.phone}</a> : "—"}</dd>
            <dt>E-mail</dt><dd>{a.customer.email ?? "—"}</dd>
            <dt>Project</dt><dd className="mono">{a.projectNumber}</dd>
          </dl>
          {a.notes && <div className="alert info" style={{ marginTop: 12 }}>{a.notes}</div>}
        </div>
        <div className="card">
          <h2>Wat er geïnstalleerd wordt</h2>
          {!a.scope.length ? <p className="muted">—</p> : (
            <table><tbody>{a.scope.map((l, i) => <tr key={i}><td>{l.description}{l.kind === "extra_work" && <span className="badge yellow" style={{ marginLeft: 6 }}>meerwerk</span>}<div className="muted mono" style={{ fontSize: 11 }}>{l.code}</div></td><td className="num">{formatQty(l.quantity)}×</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Foto's</h2>
          {a.status === "planned" && <PhotoUpload uploadUrl={`/partner/appointments/${a.id}/files`} onUploaded={() => void refresh()} />}
        </div>
        <PhotoGrid files={a.files.filter((f) => f.id !== a.reportDetail?.customerSignatureFileId)} />
      </div>
      {a.reportDetail?.review === "rejected" && a.status === "planned" && <div className="alert error">Rapport afgekeurd door Gecko: {a.reportDetail.reviewNote}. Vul het rapport opnieuw in.</div>}
      {a.report && a.status === "completed" && (
        <div className="alert info">Rapport ingediend — {REPORT_REVIEW[a.report.review]!.label.toLowerCase()}.{a.reportDetail?.reviewNote ? ` Opmerking: ${a.reportDetail.reviewNote}` : ""}</div>
      )}
      {canReport && <ReportForm appointment={a} onDone={() => void refresh()} />}
      {a.status === "planned" && !canReport && <p className="muted">Het rapport kunt u invullen op of na de dag van de afspraak.</p>}
    </>
  );
}

function ReportForm({ appointment: a, onDone }: { appointment: PartnerAppointmentDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const survey = a.type === "survey";
  const checks = survey ? SURVEY_CHECKS : INSTALL_CHECKS;
  const [positive, setPositive] = useState(true);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(Object.fromEntries(checks.map((c) => [c, false])));
  const [remarks, setRemarks] = useState("");
  const [serials, setSerials] = useState("");
  const [extra, setExtra] = useState<{ productId: string; quantity: string; note: string }[]>([]);
  const [signedName, setSignedName] = useState([a.customer.firstName, a.customer.lastName].filter(Boolean).join(" "));
  const [signature, setSignature] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: async () => {
      let customerSignatureFileId: string | null = null;
      if (!survey) {
        if (!signature) throw new Error("Laat de klant eerst tekenen");
        customerSignatureFileId = (await api.post<{ id: string }>(`/partner/appointments/${a.id}/files`, { filename: "handtekening-klant.jpg", dataBase64: signature })).id;
      }
      return api.post(`/partner/appointments/${a.id}/report`, {
        positive,
        data: {
          remarks: remarks || undefined,
          checklist,
          serialNumbers: serials.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
          extraWork: survey ? extra.filter((x) => x.productId).map((x) => ({ productId: x.productId, quantity: Number(x.quantity.replace(",", ".")) || 1, note: x.note || undefined })) : undefined,
        },
        customerSignedName: survey ? null : signedName,
        customerSignatureFileId,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["partner-appointments"] });
      onDone();
    },
  });

  return (
    <div className="card">
      <h2>{survey ? "Schouwrapport" : "Opleverrapport"}</h2>
      <ErrorBox error={submit.error} />
      <div className="row" style={{ marginBottom: 12 }}>
        <button type="button" className={`btn ${positive ? "primary" : ""}`} onClick={() => setPositive(true)}>{survey ? "Technisch haalbaar" : "Installatie werkt"}</button>
        <button type="button" className={`btn ${!positive ? "danger" : ""}`} onClick={() => setPositive(false)}>{survey ? "Niet haalbaar" : "Werkt (nog) niet"}</button>
      </div>
      {checks.map((c) => (
        <label key={c} className="checkbox"><input type="checkbox" checked={checklist[c]} onChange={(e) => setChecklist({ ...checklist, [c]: e.target.checked })} /> {c}</label>
      ))}
      <Field label="Opmerkingen"><textarea rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
      {!survey && <Field label="Serienummers (één per regel)"><textarea rows={2} className="mono" value={serials} onChange={(e) => setSerials(e.target.value)} /></Field>}
      {survey && (
        <div style={{ marginBottom: 12 }}>
          <div className="field">Meerwerk</div>
          <p className="muted" style={{ fontSize: 13 }}>Alleen meerwerk dat nu wordt vastgesteld kan aan de klant worden doorberekend. Meerwerk dat bij de schouw is gemist, is voor rekening van de installateur.</p>
          {extra.map((x, i) => (
            <div key={i} className="row" style={{ marginBottom: 6, flexWrap: "nowrap" }}>
              <select style={{ flex: 2, minWidth: 0 }} value={x.productId} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, productId: e.target.value } : y)))}>
                <option value="">Kies meerwerk…</option>
                {a.extraWorkProducts.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
              <input style={{ width: 60 }} value={x.quantity} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, quantity: e.target.value } : y)))} aria-label="Aantal" />
              <input style={{ flex: 1, minWidth: 0 }} placeholder="toelichting" value={x.note} onChange={(e) => setExtra(extra.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} />
              <button type="button" className="btn small danger" onClick={() => setExtra(extra.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn small" disabled={!a.extraWorkProducts.length} onClick={() => setExtra([...extra, { productId: "", quantity: "1", note: "" }])}>+ Meerwerk</button>
          {!a.extraWorkProducts.length && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>Geen meerwerkproducten beschikbaar voor deze productgroep.</span>}
        </div>
      )}
      {!survey && (
        <>
          <Field label="Naam klant"><input value={signedName} onChange={(e) => setSignedName(e.target.value)} /></Field>
          <div className="field">Handtekening klant voor oplevering</div>
          <SignaturePad onChange={setSignature} />
        </>
      )}
      <button className="btn primary" style={{ marginTop: 16 }} disabled={submit.isPending} onClick={() => submit.mutate()}>Rapport indienen</button>
    </div>
  );
}

function PartnerAvailability() {
  const qc = useQueryClient();
  const weeks = 8;
  const from = todayIso();
  const to = addDaysIso(from, weeks * 7 + 7);
  const regions = useQuery({ queryKey: ["partner-regions"], queryFn: () => api.get<(Region & { selected: boolean })[]>("/partner/regions") });
  const blocks = useQuery({ queryKey: ["partner-availability", from], queryFn: () => api.get<AvailabilityBlock[]>(`/partner/availability?from=${addDaysIso(from, -7)}&to=${to}`) });
  return (
    <>
      <PageHead title="Beschikbaarheid" sub="Klik per dag de ochtend en middag aan waarop u beschikbaar bent. Een schouw neemt één dagdeel in, een installatie de hele dag. U wordt aan deze beschikbaarheid gehouden." />
      {regions.data && (
        <WorkArea
          regions={regions.data}
          selected={regions.data.filter((r) => r.selected).map((r) => r.id)}
          onSave={async (regionIds) => {
            await api.put("/partner/regions", { regionIds });
            await qc.invalidateQueries({ queryKey: ["partner-regions"] });
          }}
        />
      )}
      {blocks.isLoading ? <Loading /> : (
        <AvailabilityGrid
          blocks={blocks.data ?? []}
          weeks={weeks}
          onSave={async (changes) => {
            await api.put("/partner/availability", { changes });
            await qc.invalidateQueries({ queryKey: ["partner-availability"] });
          }}
        />
      )}
    </>
  );
}
