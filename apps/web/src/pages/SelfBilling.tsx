import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { SB_KIND, SelfBillingDocument, type SelfBillingDetail } from "../components/SelfBillingDocument";
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
type Summary = Omit<SelfBillingDetail, "lines" | "vatBreakdown" | "partnerSnapshot" | "companySnapshot">;

export const SB_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Concept", cls: "" },
  final: { label: "Te betalen", cls: "yellow" },
  paid: { label: "Betaald", cls: "green" },
};
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
                  <td><span className={`badge ${SB_STATUS[i.status]!.cls}`}>{SB_STATUS[i.status]!.label}</span>{i.paidAt && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>{formatDate(i.paidAt)}</span>}</td>
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
        sub={`${SB_KIND[d.kind]} · ${SB_STATUS[d.status]!.label}${d.sentAt ? ` · gemaild ${formatDate(d.sentAt)}` : ""}${d.paidAt ? ` · betaald ${formatDate(d.paidAt)}` : ""}`}
        actions={
          <>
            {manage && isDraft && <button className="btn" onClick={() => confirm("Concept verwijderen? De posten komen terug bij Uit te betalen.") && del.mutate()}>Concept verwijderen</button>}
            {manage && isDraft && <button className="btn" onClick={() => setCorrection(true)}>Correctieregel</button>}
            {manage && isDraft && (
              <button
                className="btn primary"
                disabled={finalize.isPending}
                onClick={() => confirm("Definitief maken? De factuur krijgt een nummer, is daarna niet meer te wijzigen en wordt naar de partner gemaild.") && finalize.mutate()}
              >
                Definitief maken en mailen
              </button>
            )}
            {!isDraft && <a className="btn" href={`/selfbilling/${d.id}/print`} target="_blank" rel="noreferrer">Afdrukken / PDF</a>}
            {manage && d.status === "final" && <button className="btn primary" onClick={() => setPaying(true)}>Markeren als betaald</button>}
          </>
        }
      />
      <ErrorBox error={finalize.error ?? remove.error ?? del.error} />
      {isDraft && <div className="alert info">Concept: controleer de regels. Weggehaalde regels komen terug bij "Uit te betalen". Bij definitief maken krijgt de factuur een nummer uit de reeks van {d.partnerName}.</div>}
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
