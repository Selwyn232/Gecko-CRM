import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ApprovalInfo, SB_KIND, sbStatus, SelfBillingDocument, type SelfBillingDetail } from "../components/SelfBillingDocument";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { formatCents, formatDate, formatPercent, parseEuro, todayIso } from "../format";

interface OpenItem {
  kind: "fee" | "installation" | "extra_work";
  projectId: string;
  projectNumber: string;
  advisorName: string | null;
  description: string;
  basisCents: number | null;
  feeBasisPoints: number | null;
  amountCents: number | null;
  missing: string | null;
}
interface OpenPartner {
  partner: { id: string; name: string; type: string; email: string | null };
  kind: "sales_fee" | "installation";
  vatMode: "normal" | "reverse_charge";
  items: OpenItem[];
  penalties: { id: string; amountCents: number; reason: string; createdAt: string }[];
  readyCents: number;
  canBill: boolean;
}
type Summary = Omit<SelfBillingDetail, "lines" | "vatBreakdown" | "partnerSnapshot" | "companySnapshot" | "approval"> & { approvalStatus: SelfBillingDetail["approval"]["status"] };
const ITEM_KIND: Record<string, string> = { fee: "Fee", installation: "Installatie", extra_work: "Meerwerk" };

export function SelfBillingPage() {
  const [tab, setTab] = useState<"open" | "invoices">("open");
  return (
    <>
      <PageHead
        title="Selfbilling"
        sub="Uitbetalingen aan Greenteam (fee na betaalde aanbetaling) en installatiepartners (na betaalde eindfactuur, minus boetes). Gecko maakt de factuur namens de partner op."
      />
      <div className="tabs">
        <button className={tab === "open" ? "active" : ""} onClick={() => setTab("open")}>Uit te betalen</button>
        <button className={tab === "invoices" ? "active" : ""} onClick={() => setTab("invoices")}>Facturen</button>
      </div>
      {tab === "open" ? <OpenItems /> : <InvoiceList />}
    </>
  );
}

function OpenItems() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useQuery({ queryKey: ["selfbilling", "open"], queryFn: () => api.get<OpenPartner[]>("/selfbilling/open") });
  const draft = useMutation({
    mutationFn: (partnerId: string) => api.post<SelfBillingDetail>("/selfbilling/drafts", { partnerId }),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ["selfbilling"] });
      navigate(`/selfbilling/${d.id}`);
    },
  });
  if (open.isLoading) return <Loading />;
  if (!open.data?.length) return <div className="card empty">Er is op dit moment niets uit te betalen.</div>;
  return (
    <>
      <ErrorBox error={draft.error} />
      {open.data.map((p) => (
        <div key={p.partner.id} className="card flush">
          <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
            <div>
              <h2 style={{ margin: 0 }}>{p.partner.name}</h2>
              <div className="row" style={{ marginTop: 4 }}>
                <span className="badge">{SB_KIND[p.kind]}</span>
                <span className="badge">{p.vatMode === "reverse_charge" ? "Btw verlegd" : "Btw 21%"}</span>
                {!p.partner.email && <span className="badge yellow" title="De factuur wordt niet gemaild">Geen e-mailadres</span>}
              </div>
            </div>
            <div className="row">
              <span>Klaar voor uitbetaling: <strong>{formatCents(p.readyCents)}</strong> <span className="muted">excl. btw</span></span>
              {can("invoices.manage") && (
                <button className="btn primary" disabled={!p.canBill || draft.isPending} onClick={() => draft.mutate(p.partner.id)}>Conceptfactuur maken</button>
              )}
            </div>
          </div>
          <table>
            <thead><tr><th>Soort</th><th>Omschrijving</th>{p.kind === "sales_fee" && <><th>Adviseur</th><th className="num">Grondslag</th><th className="num">Fee</th></>}<th className="num">Bedrag</th></tr></thead>
            <tbody>
              {p.items.map((i, n) => (
                <tr key={n}>
                  <td>{ITEM_KIND[i.kind]}</td>
                  <td>
                    <Link to={`/projecten/${i.projectId}`}>{i.description}</Link>
                    {i.missing && <div className="badge red" style={{ marginTop: 4, whiteSpace: "normal" }}>{i.missing}</div>}
                  </td>
                  {p.kind === "sales_fee" && <><td>{i.advisorName ?? <span className="muted">—</span>}</td><td className="num">{formatCents(i.basisCents)}</td><td className="num">{i.feeBasisPoints != null ? formatPercent(i.feeBasisPoints) : "—"}</td></>}
                  <td className="num">{formatCents(i.amountCents)}</td>
                </tr>
              ))}
              {p.penalties.map((pen) => (
                <tr key={pen.id}>
                  <td>Boete</td>
                  <td>{pen.reason} <span className="muted">({formatDate(pen.createdAt)})</span></td>
                  {p.kind === "sales_fee" && <><td /><td /><td /></>}
                  <td className="num">{formatCents(-pen.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!p.canBill && p.penalties.length > 0 && !p.items.length && (
            <p className="muted" style={{ padding: "0 20px 12px", fontSize: 13 }}>De boete wordt verrekend met de volgende uitbetaling aan deze partner.</p>
          )}
        </div>
      ))}
    </>
  );
}

function InvoiceList() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["selfbilling", "list"], queryFn: () => api.get<Summary[]>("/selfbilling") });
  const [from, setFrom] = useState(`${todayIso().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayIso());
  if (list.isLoading) return <Loading />;
  return (
    <>
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 13 }}>Export voor Exact (inkoopboek), definitieve facturen op factuurdatum:</span>
        <div className="row">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>t/m</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <a className="btn" href={`/api/selfbilling/export.csv?from=${from}&to=${to}`}>CSV downloaden</a>
        </div>
      </div>
      <div className="card flush">
        {!list.data?.length ? <div className="empty">Nog geen selfbillingfacturen.</div> : (
          <table>
            <thead><tr><th>Nummer</th><th>Partner</th><th>Soort</th><th>Datum</th><th className="num">Totaal</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/selfbilling/${i.id}`)}>
                  <td className="mono">{i.number ?? <span className="muted">concept</span>}</td>
                  <td>{i.partnerName}</td>
                  <td>{SB_KIND[i.kind]}</td>
                  <td>{formatDate(i.invoiceDate ?? i.createdAt)}</td>
                  <td className="num">{formatCents(i.totalCents)}</td>
                  <td><span className={`badge ${sbStatus(i.status, i.approvalStatus).cls}`}>{sbStatus(i.status, i.approvalStatus).label}</span>{i.paidAt && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{formatDate(i.paidAt)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function SelfBillingDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inv = useQuery({ queryKey: ["selfbilling", id], queryFn: () => api.get<SelfBillingDetail>(`/selfbilling/${id}`) });
  const [correction, setCorrection] = useState(false);
  const [paying, setPaying] = useState(false);
  const refresh = async (d?: SelfBillingDetail) => {
    if (d) qc.setQueryData(["selfbilling", id], d);
    await qc.invalidateQueries({ queryKey: ["selfbilling"] });
  };
  const finalize = useMutation({ mutationFn: () => api.post<SelfBillingDetail>(`/selfbilling/${id}/finalize`), onSuccess: refresh });
  const [resent, setResent] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () => api.post<{ sentTo: string | null }>(`/selfbilling/${id}/request-approval`),
    onSuccess: async (r) => {
      setResent(r.sentTo ? `Opnieuw ter akkoord gemaild naar ${r.sentTo}. De vorige link werkt niet meer.` : "Geen e-mailadres bij deze partner; vul dat in bij Organisaties.");
      await refresh();
    },
  });
  const remove = useMutation({ mutationFn: (lineId: string) => api.del<SelfBillingDetail>(`/selfbilling/${id}/lines/${lineId}`), onSuccess: refresh });
  const del = useMutation({
    mutationFn: () => api.del(`/selfbilling/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["selfbilling"] });
      navigate("/selfbilling");
    },
  });
  if (inv.isLoading) return <Loading />;
  if (!inv.data) return <ErrorBox error={inv.error} />;
  const d = inv.data;
  const manage = can("invoices.manage");
  const isDraft = d.status === "draft";
  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/selfbilling">← Selfbilling</Link></div>
      <PageHead
        title={`${d.number ?? "Concept"} — ${d.partnerName}`}
        sub={`${SB_KIND[d.kind]} · ${sbStatus(d.status, d.approval.status).label}${d.sentAt ? ` · ter akkoord gemaild ${formatDate(d.sentAt)}` : ""}${d.paidAt ? ` · betaald ${formatDate(d.paidAt)}` : ""}`}
        actions={
          <>
            {manage && isDraft && <button className="btn" onClick={() => confirm("Concept verwijderen? De posten komen terug bij Uit te betalen.") && del.mutate()}>Concept verwijderen</button>}
            {manage && isDraft && <button className="btn" onClick={() => setCorrection(true)}>Correctieregel</button>}
            {manage && isDraft && (
              <button
                className="btn primary"
                disabled={finalize.isPending}
                onClick={() => confirm("Definitief maken? De factuur krijgt een nummer, is daarna niet meer te wijzigen en wordt ter akkoord naar de partner gemaild.") && finalize.mutate()}
              >
                Definitief maken en ter akkoord sturen
              </button>
            )}
            {manage && d.status === "final" && d.approval.status !== "approved" && (
              <button className="btn" disabled={resend.isPending} onClick={() => resend.mutate()}>Opnieuw ter akkoord sturen</button>
            )}
            {!isDraft && <a className="btn" href={`/selfbilling/${d.id}/print`} target="_blank" rel="noreferrer">Afdrukken / PDF</a>}
            {manage && d.status === "final" && (
              <button className="btn primary" disabled={d.approval.status !== "approved"} title={d.approval.status !== "approved" ? "Kan pas na akkoord van de ontvanger" : undefined} onClick={() => setPaying(true)}>
                Markeren als betaald
              </button>
            )}
          </>
        }
      />
      <ErrorBox error={finalize.error ?? remove.error ?? del.error ?? resend.error} />
      {resent && <div className="alert info">{resent}</div>}
      <ApprovalInfo a={d.approval} />
      {d.status === "final" && d.approval.status === "pending" && (
        <div className="alert warning">
          Wacht op akkoord van {d.partnerName}. {d.partnerSnapshot.email ? `De akkoordlink is gemaild naar ${d.partnerSnapshot.email}.` : "Er is geen e-mailadres bekend; vul dat in bij Organisaties en stuur opnieuw ter akkoord."}{" "}
          {d.kind === "installation" && "De partner kan ook akkoord geven in het partnerportaal. "}Uitbetalen kan pas na akkoord.
        </div>
      )}
      {isDraft && <div className="alert info">Concept: controleer de regels. Weggehaalde regels komen terug bij "Uit te betalen". Bij definitief maken krijgt de factuur een nummer uit de reeks van {d.partnerName} en gaat hij per e-mail ter akkoord naar de partner; uitbetalen kan pas na akkoord.</div>}
      <div className="card"><SelfBillingDocument d={d} onRemoveLine={manage && isDraft ? (lineId) => remove.mutate(lineId) : undefined} /></div>
      {correction && <CorrectionForm id={d.id} vatMode={d.vatMode} onClose={() => setCorrection(false)} onSaved={refresh} />}
      {paying && <PaidForm id={d.id} onClose={() => setPaying(false)} onSaved={refresh} />}
    </>
  );
}

function CorrectionForm({ id, vatMode, onClose, onSaved }: { id: string; vatMode: string; onClose: () => void; onSaved: (d: SelfBillingDetail) => void }) {
  const [form, setForm] = useState({ description: "", amount: "", withVat: true });
  const cents = parseEuro(form.amount);
  const save = useMutation({
    mutationFn: () => api.post<SelfBillingDetail>(`/selfbilling/${id}/corrections`, { description: form.description, amountCents: cents, withVat: form.withVat }),
    onSuccess: (d) => {
      onSaved(d);
      onClose();
    },
  });
  return (
    <Modal title="Correctieregel" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <Field label="Omschrijving"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required maxLength={300} /></Field>
        <Field label="Bedrag excl. btw (negatief = inhouden, bv. -150)"><input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></Field>
        {vatMode === "normal" && (
          <label className="row" style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={form.withVat} onChange={(e) => setForm({ ...form, withVat: e.target.checked })} /> Met btw (uit = buiten de btw, bv. schadevergoeding)
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={!cents || save.isPending}>Toevoegen</button>
        </div>
      </form>
    </Modal>
  );
}

function PaidForm({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: (d: SelfBillingDetail) => void }) {
  const [paidAt, setPaidAt] = useState(todayIso());
  const save = useMutation({
    mutationFn: () => api.post<SelfBillingDetail>(`/selfbilling/${id}/paid`, { paidAt }),
    onSuccess: (d) => {
      onSaved(d);
      onClose();
    },
  });
  return (
    <Modal title="Uitbetaling vastleggen" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <Field label="Betaald op"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} required /></Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={save.isPending}>Opslaan</button>
        </div>
      </form>
    </Modal>
  );
}

/** Afdrukversie; `path` maakt hem ook bruikbaar in het partnerportaal. */
export function SelfBillingPrintPage({ path = "/selfbilling" }: { path?: string }) {
  const { id } = useParams();
  const inv = useQuery({ queryKey: ["selfbilling-print", path, id], queryFn: () => api.get<SelfBillingDetail>(`${path}/${id}`) });
  useEffect(() => {
    if (inv.data) document.title = `Selfbillingfactuur ${inv.data.number ?? "concept"}`;
  }, [inv.data]);
  if (inv.error) return <ErrorBox error={inv.error} />;
  if (!inv.data) return <Loading />;
  return (
    <div className="print-page">
      <div className="print-actions no-print"><button className="btn primary" onClick={() => window.print()}>Afdrukken / opslaan als PDF</button></div>
      <SelfBillingDocument d={inv.data} />
    </div>
  );
}

/** Akkoordpagina voor de ontvanger (link uit de e-mail, zonder inloggen). */
export function PublicSelfBillingPage() {
  const { token } = useParams();
  const qc = useQueryClient();
  const inv = useQuery({ queryKey: ["public-selfbilling", token], queryFn: () => api.get<SelfBillingDetail>(`/public/selfbilling/${token}`), retry: false });
  useEffect(() => {
    if (inv.data) document.title = `Selfbillingfactuur ${inv.data.number}`;
  }, [inv.data]);
  if (inv.error) return <div className="public-page"><ErrorBox error={inv.error} /><p>Heeft u inmiddels een nieuwere e-mail gekregen? Gebruik dan de link daarin.</p></div>;
  if (!inv.data) return <Loading />;
  return (
    <div className="public-page">
      <ApprovalBox
        d={inv.data}
        submit={(body) => api.post<SelfBillingDetail>(`/public/selfbilling/${token}/decision`, body)}
        onDone={(d) => qc.setQueryData(["public-selfbilling", token], d)}
      />
      <div className="card"><SelfBillingDocument d={inv.data} /></div>
    </div>
  );
}

/** Akkoord / niet akkoord geven; gebruikt op de openbare pagina en in het partnerportaal. */
export function ApprovalBox({
  d,
  submit,
  onDone,
  defaultName = "",
}: {
  d: SelfBillingDetail;
  submit: (body: { decision: "approve" | "dispute"; name: string; reason?: string }) => Promise<SelfBillingDetail>;
  onDone: (d: SelfBillingDetail) => void;
  defaultName?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState("");
  const [agree, setAgree] = useState(false);
  const decide = useMutation({ mutationFn: submit, onSuccess: onDone });
  if (d.status === "paid") return <div className="alert info"><strong>Betaald</strong> op {formatDate(d.paidAt)}.</div>;
  if (d.approval.status === "approved") return <ApprovalInfo a={d.approval} />;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{d.approval.status === "disputed" ? "U heeft aangegeven niet akkoord te zijn" : "Akkoord geven op deze factuur"}</h2>
      {d.approval.status === "disputed" ? (
        <p>Reden: {d.approval.disputeReason}. {d.companySnapshot.name} neemt contact met u op. Bent u na overleg toch akkoord? Dan kunt u hieronder alsnog akkoord geven.</p>
      ) : (
        <p>
          {d.companySnapshot.name} heeft deze factuur op grond van de zelffactureringsovereenkomst namens {d.partnerSnapshot.name} opgemaakt.
          Controleer de specificatie hieronder. <strong>De factuur wordt uitbetaald nadat u akkoord heeft gegeven.</strong>
        </p>
      )}
      <ErrorBox error={decide.error} />
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          decide.mutate(disputing ? { decision: "dispute", name, reason } : { decision: "approve", name });
        }}
      >
        <Field label="Uw naam"><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} autoComplete="name" /></Field>
        {disputing ? (
          <>
            <Field label="Wat klopt er niet?"><textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} /></Field>
            <div className="row">
              <button type="button" className="btn" onClick={() => setDisputing(false)}>Terug</button>
              <button className="btn danger" disabled={decide.isPending}>Niet akkoord versturen</button>
            </div>
          </>
        ) : (
          <>
            <label className="row" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              Ik ga namens {d.partnerSnapshot.name} akkoord met factuur {d.number} van {formatCents(d.totalCents)}.
            </label>
            <div className="row">
              <button className="btn primary" disabled={!agree || decide.isPending}>Akkoord geven</button>
              {d.approval.status !== "disputed" && <button type="button" className="btn" onClick={() => setDisputing(true)}>Niet akkoord</button>}
            </div>
          </>
        )}
      </form>
      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>Uw keuze wordt vastgelegd met naam, datum en tijd, IP-adres en apparaat.</p>
    </div>
  );
}
