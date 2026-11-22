import { PasskeysButton } from "../components/Passkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api, type Appointment, type AvailabilityBlock, type Penalty, type Region, type Report, type Technician } from "../api";
import { TechnicianDay } from "./TechnicianDay";
import { photoUrl } from "../components/Avatar";
import { OwnPhotoButton } from "../components/Specialist";
import { LocationBar, LocationProvider } from "./LocationSharing";
import { NavIcon, type IconName } from "../components/icons";
import { WorkArea } from "../components/WorkArea";
import { sbStatus, SelfBillingDocument, type SelfBillingDetail } from "../components/SelfBillingDocument";
import { ApprovalBox } from "../pages/SelfBilling";
import { useAuth } from "../auth";
import { AvailabilityGrid } from "../components/AvailabilityGrid";
import { ChangePasswordModal } from "../components/ChangePassword";
import { PhotoGrid, PhotoUpload } from "../components/PhotoUpload";
import { SignaturePad } from "../components/SignaturePad";
import { ErrorBox, Field, Loading, PageHead } from "../components/ui";
import { addDaysIso, APPOINTMENT_STATUS, APPOINTMENT_TYPE, formatCents, formatDate, formatQty, REPORT_REVIEW, TIME_WINDOW, todayIso, weekday } from "../format";

/** Portaal voor installatiepartners: alleen eigen afspraken, rapporten en beschikbaarheid. Monteurs (B87) zien alleen hun eigen dag. */
export function PartnerApp() {
  const { me, logout, can } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const partner = can("partner.portal");
  const technician = can("technician.portal") && !!me?.isTechnician;
  const tabs: { to: string; label: string; icon: IconName }[] = [
    ...(technician ? [{ to: "/mijn-dag", label: "Mijn dag", icon: "werk" as IconName }] : []),
    ...(partner
      ? [
          { to: "/afspraken", label: "Afspraken", icon: "planning" as IconName },
          { to: "/monteurs", label: "Monteurs", icon: "gebruikers" as IconName },
          { to: "/beschikbaarheid", label: "Beschikbaar", icon: "beschikbaarheid" as IconName },
          { to: "/uitbetalingen", label: "Uitbetaling", icon: "facturen" as IconName },
        ]
      : []),
  ];
  const account = (
    <>
      <div style={{ color: "var(--text)", fontWeight: 500 }}>{me?.name}</div>
      <div>{me?.organizationName}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => { setAccountOpen(false); setChangingPassword(true); }}>Wachtwoord</button>
        <PasskeysButton />
        <OwnPhotoButton />
        <button className="btn small" onClick={logout}>Uitloggen</button>
      </div>
    </>
  );
  return (
    <LocationProvider>
    <div className="shell compact portal-app">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">G</span> {partner ? "Partnerportaal" : "Monteur"}</div>
        <nav className="nav">
          {tabs.map((t) => <NavLink key={t.to} to={t.to}><NavIcon name={t.icon} />{t.label === "Beschikbaar" ? "Beschikbaarheid" : t.label === "Uitbetaling" ? "Uitbetalingen" : t.label}</NavLink>)}
        </nav>
        <div className="sidebar-footer">{account}</div>
      </aside>
      {/* Telefoon: smalle kopbalk met accountmenu en een tabbalk onderin */}
      <header className="portal-top">
        <div className="brand"><span className="brand-mark">G</span> {partner ? "Partnerportaal" : "Monteur"}</div>
        <button className="portal-account-btn" aria-expanded={accountOpen} aria-label="Account" onClick={() => setAccountOpen(!accountOpen)}>
          {me?.photoVersion ? <img src={photoUrl(me.id, me.photoVersion)!} alt="" /> : (me?.name ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
        </button>
        {accountOpen && <div className="portal-account-menu">{account}</div>}
      </header>
      <main className="main">
        {technician && <LocationBar />}
        <Routes>
          <Route path="/" element={<Navigate to={partner ? "/afspraken" : "/mijn-dag"} replace />} />
          {technician && <Route path="/mijn-dag" element={<TechnicianDay />} />}
          <Route path="/afspraken/:id" element={<PartnerAppointment />} />
          {partner && <Route path="/afspraken" element={<PartnerAppointments />} />}
          {partner && <Route path="/monteurs" element={<PartnerTechnicians />} />}
          {partner && <Route path="/beschikbaarheid" element={<PartnerAvailability />} />}
          {partner && <Route path="/uitbetalingen" element={<PartnerPayouts />} />}
          {partner && <Route path="/uitbetalingen/:id" element={<PartnerPayout />} />}
          <Route path="*" element={<Navigate to={partner ? "/afspraken" : "/mijn-dag"} replace />} />
        </Routes>
      </main>
      {tabs.length > 1 && (
        <nav className="portal-tabs" aria-label="Menu">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to}>
              <NavIcon name={t.icon} />
              <span>{t.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
    </LocationProvider>
  );
}

/** B87: monteurs met eigen inlog. Zij krijgen klussen, geven per blok van 2 uur beschikbaarheid op en melden zich aan en af. */
function PartnerTechnicians() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["partner-technicians"], queryFn: () => api.get<Technician[]>("/partner/technicians") });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const add = useMutation({
    meta: { toast: "Monteur toegevoegd; uitnodiging verstuurd" },
    mutationFn: () => api.post("/partner/technicians", { name, email }),
    onSuccess: async () => {
      setName("");
      setEmail("");
      await qc.invalidateQueries({ queryKey: ["partner-technicians"] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { isTechnician?: boolean; isActive?: boolean } }) => api.patch(`/partner/technicians/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["partner-technicians"] }),
  });
  return (
    <>
      <PageHead title="Monteurs" sub="Iedere monteur heeft een eigen inlog. Hij ziet alleen zijn eigen klussen, meldt zich aan en af (opleveren) en deelt tijdens de werkdag zijn locatie, zodat klanten een aankomsttijd krijgen." />
      <ErrorBox error={list.error ?? add.error ?? update.error} />
      <div className="card flush">
        {list.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th>Naam</th><th>E-mail</th><th>Monteur</th><th>Account</th><th>Laatste locatie</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.email}</td>
                  <td>
                    <label className="checkbox"><input type="checkbox" checked={!!t.isTechnician} onChange={(e) => update.mutate({ id: t.id, body: { isTechnician: e.target.checked } })} /> krijgt klussen</label>
                  </td>
                  <td>
                    {t.isActive ? <button className="btn small" onClick={() => update.mutate({ id: t.id, body: { isActive: false } })}>Uitzetten</button> : <button className="btn small" onClick={() => update.mutate({ id: t.id, body: { isActive: true } })}>Aanzetten</button>}
                  </td>
                  <td className="muted">{t.lastLocationAt ? new Date(t.lastLocationAt).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h2>Monteur toevoegen</h2>
        <div className="grid-2">
          <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
          <Field label="E-mailadres (inlognaam)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        </div>
        <button className="btn primary" disabled={add.isPending}>Toevoegen en uitnodigen</button>
      </form>
    </>
  );
}

/** Selfbillingfacturen die Gecko namens deze partner heeft opgemaakt; hier ook akkoord geven. */
function PartnerPayouts() {
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["partner-selfbilling"],
    queryFn: () => api.get<{ id: string; number: string; invoiceDate: string; totalCents: number; status: string; approvalStatus: "pending" | "approved" | "disputed" | null; paidAt: string | null }[]>("/partner/selfbilling"),
  });
  if (list.isLoading) return <Loading />;
  const waiting = (list.data ?? []).filter((i) => i.status === "final" && i.approvalStatus !== "approved").length;
  return (
    <>
      <PageHead title="Uitbetalingen" sub="Facturen die Gecko op grond van de zelffactureringsovereenkomst namens u heeft opgemaakt. Wij betalen uit nadat u akkoord heeft gegeven." />
      {waiting > 0 && <div className="alert warning">{waiting === 1 ? "1 factuur wacht" : `${waiting} facturen wachten`} op uw akkoord.</div>}
      <div className="card flush">
        {!list.data?.length ? <div className="empty">Nog geen uitbetalingen.</div> : (
          <table>
            <thead><tr><th>Factuur</th><th>Datum</th><th className="num">Bedrag</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((i) => {
                const st = sbStatus(i.status, i.approvalStatus);
                return (
                  <tr key={i.id} className="clickable" onClick={() => navigate(`/uitbetalingen/${i.id}`)}>
                    <td className="mono">{i.number}</td>
                    <td>{formatDate(i.invoiceDate)}</td>
                    <td className="num">{formatCents(i.totalCents)}</td>
                    <td><span className={`badge ${st.cls}`}>{st.label}</span>{i.paidAt && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{formatDate(i.paidAt)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function PartnerPayout() {
  const { id } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const inv = useQuery({ queryKey: ["partner-selfbilling", id], queryFn: () => api.get<SelfBillingDetail>(`/partner/selfbilling/${id}`) });
  if (inv.error) return <ErrorBox error={inv.error} />;
  if (!inv.data) return <Loading />;
  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/uitbetalingen">← Uitbetalingen</Link></div>
      <PageHead title={`Factuur ${inv.data.number}`} actions={<a className="btn" href={`/uitbetalingen/${inv.data.id}/print`} target="_blank" rel="noreferrer">Afdrukken / PDF</a>} />
      <ApprovalBox
        d={inv.data}
        defaultName={me?.name ?? ""}
        submit={(body) => api.post<SelfBillingDetail>(`/partner/selfbilling/${id}/decision`, body)}
        onDone={async (d) => {
          qc.setQueryData(["partner-selfbilling", id], d);
          await qc.invalidateQueries({ queryKey: ["partner-selfbilling"] });
        }}
      />
      <div className="card"><SelfBillingDocument d={inv.data} /></div>
    </>
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
          <>
          <div className="only-mobile">
            {list.data.map((a) => (
              <Link key={a.id} to={`/afspraken/${a.id}`} className="appt-card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{weekday(a.date)} · {a.time ?? TIME_WINDOW[a.timeWindow]}{a.technicianName ? ` · ${a.technicianName}` : ""}</strong>
                  {a.report ? <span className={`status ${REPORT_REVIEW[a.report.review]!.color}`}>{REPORT_REVIEW[a.report.review]!.label}</span> : a.status === "planned" && a.date <= todayIso() ? <span className="badge yellow">Rapport indienen</span> : <span className={`status ${APPOINTMENT_STATUS[a.status]!.color}`}>{APPOINTMENT_STATUS[a.status]!.label}</span>}
                </div>
                <div>{APPOINTMENT_TYPE[a.type]} {a.productGroupName.toLowerCase()}{a.days > 1 && ` (${a.days} dagen)`}</div>
                <div className="muted" style={{ fontSize: 13 }}>{[a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ")} · {a.address}</div>
              </Link>
            ))}
          </div>
          <table className="only-desktop">
            <thead><tr><th>Datum</th><th>Soort</th><th>Klant / adres</th><th>Status</th><th>Rapport</th></tr></thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate(`/afspraken/${a.id}`)}>
                  <td style={{ whiteSpace: "nowrap" }}>{weekday(a.date)}{a.days > 1 && <span className="muted"> ({a.days} dagen)</span>}<div className="muted" style={{ fontSize: 12 }}>{a.time ?? TIME_WINDOW[a.timeWindow]}{a.technicianName ? ` · ${a.technicianName}` : ""}</div></td>
                  <td>{APPOINTMENT_TYPE[a.type]} <span className="muted">{a.productGroupName}</span></td>
                  <td>{[a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ")}<div className="muted" style={{ fontSize: 12 }}>{a.address}</div></td>
                  <td><span className={`status ${APPOINTMENT_STATUS[a.status]!.color}`}>{APPOINTMENT_STATUS[a.status]!.label}</span></td>
                  <td>{a.report ? <span className={`status ${REPORT_REVIEW[a.report.review]!.color}`}>{REPORT_REVIEW[a.report.review]!.label}</span> : a.status === "planned" && a.date <= todayIso() ? <span className="badge yellow">Nog indienen</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
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
  /** Checklist van Gecko voor deze productgroep en soort afspraak. */
  checklist: { items: { id: string; label: string; required: boolean }[]; minPhotos: number };
};


function PartnerAppointment() {
  const { id } = useParams();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["partner-appointment", id], queryFn: () => api.get<PartnerAppointmentDetail>(`/partner/appointments/${id}`) });
  const testStatus = useQuery({ queryKey: ["test-status"], queryFn: () => api.get<{ testMode: boolean }>("/testing/status") });
  if (detail.isLoading) return <Loading />;
  if (!detail.data) return <ErrorBox error={detail.error} />;
  const a = detail.data;
  const canReport = a.status === "planned" && (a.date <= todayIso() || !!testStatus.data?.testMode);
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
  const checks = a.checklist.items;
  const [positive, setPositive] = useState(true);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(Object.fromEntries(checks.map((c) => [c.label, false])));
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
        <label key={c.id} className="checkbox">
          <input type="checkbox" checked={!!checklist[c.label]} onChange={(e) => setChecklist({ ...checklist, [c.label]: e.target.checked })} /> {c.label}
          {c.required && <span className="badge" style={{ marginLeft: 6 }} title="Verplicht af te vinken bij een positief rapport">verplicht</span>}
        </label>
      ))}
      {a.checklist.minPhotos > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>Minimaal {a.checklist.minPhotos} foto's nodig (bovenaan bij Foto's), nu {a.files.filter((f) => f.contentType.startsWith("image/") && !f.filename.startsWith("handtekening")).length}.</p>
      )}
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
  const techs = useQuery({ queryKey: ["partner-technicians"], queryFn: () => api.get<Technician[]>("/partner/technicians") });
  const active = (techs.data ?? []).filter((t) => t.isTechnician && t.isActive);
  const [techId, setTechId] = useState("");
  const tid = techId || active[0]?.id || "";
  const blocks = useQuery({
    queryKey: ["partner-availability", from, tid],
    queryFn: () => api.get<AvailabilityBlock[]>(`/partner/availability?from=${addDaysIso(from, -7)}&to=${to}&technicianId=${tid}`),
    enabled: !!tid,
  });
  return (
    <>
      <PageHead title="Beschikbaarheid" sub="Per monteur: klik de blokken van 2 uur aan (08–10, 10–12, 12–14, 14–16). Een service of schouw duurt 2 uur, een installatie 6 uur; de rijtijd tussen klussen rekent het systeem zelf. U wordt aan deze beschikbaarheid gehouden." />
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
      {!active.length ? (
        <div className="empty">Nog geen monteurs. Voeg ze toe bij <Link to="/monteurs">Monteurs</Link>.</div>
      ) : (
        <>
          <div className="row" style={{ margin: "12px 0" }}>
            <label className="field" style={{ margin: 0 }}>Monteur</label>
            <select value={tid} onChange={(e) => setTechId(e.target.value)}>
              {active.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {blocks.isLoading ? <Loading /> : (
            <AvailabilityGrid
              key={tid}
              blocks={blocks.data ?? []}
              weeks={weeks}
              onSave={async (changes) => {
                await api.put("/partner/availability", { technicianId: tid, changes });
                await qc.invalidateQueries({ queryKey: ["partner-availability"] });
              }}
            />
          )}
        </>
      )}
    </>
  );
}
