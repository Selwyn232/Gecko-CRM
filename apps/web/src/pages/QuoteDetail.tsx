import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Quote } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal } from "../components/ui";
import { ACCEPTANCE_METHODS, customerName, formatAddress, formatCents, formatDate, formatDateTime, formatPercent, formatQty, PRODUCT_TYPES } from "../format";
import { nameById, useAdvisors, useChannels, useOrganizations } from "../hooks";
import { QuoteStatusPill } from "./Quotes";

interface QuotableProduct {
  id: string;
  code: string;
  name: string;
  type: string;
  unit: string;
  priceCents: number;
}

export function QuoteDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const quote = useQuery({ queryKey: ["quote", id], queryFn: () => api.get<Quote>(`/quotes/${id}`) });
  const [accepting, setAccepting] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const setQuote = (q: Quote) => {
    qc.setQueryData(["quote", q.id], q);
    void qc.invalidateQueries({ queryKey: ["quotes"] });
  };
  const action = useMutation({
    mutationFn: (path: string) => api.post<Quote>(`/quotes/${id}/${path}`),
    onSuccess: (q, path) => {
      setQuote(q);
      if (path === "revise") navigate(`/offertes/${q.id}`);
    },
  });

  if (quote.isLoading) return <Loading />;
  if (!quote.data) return <ErrorBox error={quote.error ?? "Niet gevonden"} />;
  const q = quote.data;
  const draft = q.status === "draft";
  const manage = can("quotes.manage");

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link to="/offertes">← Offertes</Link> · <Link to={`/klanten/${q.customer.id}`}>{customerName(q.customer)}</Link>
      </div>
      <div className="page-head">
        <div>
          <h1>Offerte {q.displayNumber}</h1>
          <p className="row">
            <QuoteStatusPill status={q.effectiveStatus} />
            <span>{q.productGroup.name}</span>
            <span className="muted">{formatAddress(q.property)}</span>
          </p>
        </div>
        <div className="row">
          <a className="btn" href={`/offertes/${q.id}/print`} target="_blank" rel="noreferrer">Afdrukken / PDF</a>
          {manage && draft && <button className="btn primary" disabled={!q.lines.length || action.isPending} onClick={() => action.mutate("send")}>Definitief maken</button>}
          {manage && q.effectiveStatus === "sent" && <button className="btn primary" onClick={() => setAccepting(true)}>Akkoord registreren</button>}
          {manage && q.effectiveStatus === "sent" && <button className="btn danger" onClick={() => setRejecting(true)}>Afgewezen</button>}
          {manage && (q.status === "sent" || q.status === "rejected") && <button className="btn" onClick={() => action.mutate("revise")}>Nieuwe versie</button>}
        </div>
      </div>
      <ErrorBox error={action.error} />
      {draft && <div className="alert info">Concept: prijzen komen uit de actuele prijslijst van het kanaal. Bij ‘Definitief maken’ worden prijzen, btw en kostprijs vastgezet en gaat de geldigheid in.</div>}
      {q.effectiveStatus === "expired" && <div className="alert warning">Deze offerte is verlopen op {formatDate(q.validUntil)}. Maak een nieuwe versie met actuele prijzen.</div>}
      {q.status === "accepted" && (
        <div className="alert info">
          Geaccepteerd op {formatDateTime(q.acceptedAt)} door {q.acceptedByName} ({ACCEPTANCE_METHODS[q.acceptanceMethod ?? ""]}).{" "}
          {q.projectId && <Link to={`/projecten/${q.projectId}`}>Naar het project →</Link>}
        </div>
      )}
      {q.status === "rejected" && <div className="alert error">Afgewezen{q.rejectionReason ? `: ${q.rejectionReason}` : ""}.</div>}
      {q.supersedesQuoteId && <p className="muted" style={{ fontSize: 13 }}>Vervangt een eerdere versie: <Link to={`/offertes/${q.supersedesQuoteId}`}>bekijken</Link>.</p>}

      <QuoteHeader quote={q} editable={manage && draft} onSaved={setQuote} />
      <LinesCard quote={q} editable={manage && draft} onSaved={setQuote} />

      <div className="grid-2">
        <div className="card">
          <h2>Totaal</h2>
          <dl className="kv">
            <dt>Subtotaal excl. btw</dt><dd className="num" style={{ textAlign: "right" }}>{formatCents(q.totals.subtotalCents)}</dd>
            {q.totals.vat.map((v) => (
              <Fragment key={v.rateBasisPoints}><dt>Btw {formatPercent(v.rateBasisPoints)} over {formatCents(v.baseCents)}</dt><dd style={{ textAlign: "right" }}>{formatCents(v.vatCents)}</dd></Fragment>
            ))}
            <dt><strong>Totaal incl. btw</strong></dt><dd style={{ textAlign: "right" }}><strong>{formatCents(q.totals.totalCents)}</strong></dd>
          </dl>
        </div>
        {q.margin && (
          <div className="card">
            <h2>Marge (voorcalculatie)</h2>
            {!q.margin.complete && <div className="alert warning">Niet alle kostprijzen zijn bekend{!q.installationPartnerId ? " — kies een installatiepartner" : ""}. Marge is daardoor onbekend.</div>}
            <dl className="kv">
              <dt>Omzet excl. btw</dt><dd style={{ textAlign: "right" }}>{formatCents(q.totals.subtotalCents)}</dd>
              <dt>Kostprijs</dt><dd style={{ textAlign: "right" }}>{formatCents(q.margin.costCents)}</dd>
              <dt>Fee {q.salesChannel.name}</dt><dd style={{ textAlign: "right" }}>{q.margin.feeCents === null ? <span className="muted">niet ingesteld</span> : formatCents(q.margin.feeCents)}</dd>
              <dt><strong>Marge</strong></dt><dd style={{ textAlign: "right" }}><strong>{formatCents(q.margin.marginCents)}</strong> <span className="muted">({formatPercent(q.margin.marginBasisPoints)})</span></dd>
            </dl>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Niet zichtbaar voor de klant of voor medewerkers zonder recht op inkoopprijzen.</p>
          </div>
        )}
      </div>

      {accepting && <AcceptModal quote={q} onClose={() => setAccepting(false)} onSaved={setQuote} />}
      {rejecting && <RejectModal quote={q} onClose={() => setRejecting(false)} onSaved={setQuote} />}
    </>
  );
}

function QuoteHeader({ quote: q, editable, onSaved }: { quote: Quote; editable: boolean; onSaved: (q: Quote) => void }) {
  const channels = useChannels();
  const orgs = useOrganizations();
  const advisors = useAdvisors(q.salesChannel.salesPartnerOrganizationId ?? null);
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch<Quote>(`/quotes/${q.id}`, body), onSuccess: onSaved });
  const [note, setNote] = useState(q.customerNote ?? "");

  return (
    <div className="card">
      <ErrorBox error={update.error} />
      <div className="grid-2">
        <dl className="kv">
          <dt>Klant</dt><dd><Link to={`/klanten/${q.customer.id}`}>{customerName(q.customer)}</Link> <span className="muted mono">{q.customer.displayNumber}</span></dd>
          <dt>Woning</dt><dd>{formatAddress(q.property)}</dd>
          <dt>Verkoopkanaal</dt>
          <dd>
            {editable ? (
              <select value={q.salesChannelId} onChange={(e) => update.mutate({ salesChannelId: e.target.value, advisorId: null })}>
                {channels.data?.filter((c) => c.productGroupIds.includes(q.productGroupId)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : q.salesChannel.name}
          </dd>
          {q.salesChannel.salesPartnerOrganizationId && (
            <>
              <dt>Adviseur</dt>
              <dd>
                {editable ? (
                  <select value={q.advisorId ?? ""} onChange={(e) => update.mutate({ advisorId: e.target.value || null })}>
                    <option value="">—</option>
                    {advisors.data?.filter((a) => a.isActive || a.id === q.advisorId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                ) : q.advisor?.name ?? "—"}
              </dd>
            </>
          )}
        </dl>
        <dl className="kv">
          <dt>Installatiepartner</dt>
          <dd>
            {editable ? (
              <select value={q.installationPartnerId ?? ""} onChange={(e) => update.mutate({ installationPartnerId: e.target.value || null })}>
                <option value="">Nog niet bekend</option>
                {orgs.data?.filter((o) => o.type === "installation_partner" && o.isActive).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : nameById(orgs.data, q.installationPartnerId)}
          </dd>
          <dt>Prijsdatum</dt><dd>{q.priceDate ? formatDate(q.priceDate) : <span className="muted">bij definitief maken</span>}</dd>
          <dt>Geldig tot</dt><dd>{q.validUntil ? formatDate(q.validUntil) : <span className="muted">{q.salesChannel.quoteValidityDays} dagen na definitief maken</span>}</dd>
          <dt>Aangemaakt</dt><dd>{formatDateTime(q.createdAt)}</dd>
        </dl>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Tekst voor de klant (op de offerte)">
          <textarea rows={2} value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (q.customerNote ?? "") && update.mutate({ customerNote: note || null })} />
        </Field>
      </div>
    </div>
  );
}

function LinesCard({ quote: q, editable, onSaved }: { quote: Quote; editable: boolean; onSaved: (q: Quote) => void }) {
  const products = useQuery({
    queryKey: ["quotable", q.salesChannelId, q.productGroupId],
    queryFn: () => api.get<QuotableProduct[]>(`/quotes/products?salesChannelId=${q.salesChannelId}&productGroupId=${q.productGroupId}`),
    enabled: editable,
  });
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const add = useMutation({
    mutationFn: () => api.post<Quote>(`/quotes/${q.id}/lines`, { productId, quantity: Number(qty.replace(",", ".")) }),
    onSuccess: (res) => {
      onSaved(res);
      setProductId("");
      setQty("1");
    },
  });
  const update = useMutation({ mutationFn: ({ id, quantity }: { id: string; quantity: number }) => api.patch<Quote>(`/quote-lines/${id}`, { quantity }), onSuccess: onSaved });
  const remove = useMutation({ mutationFn: (lineId: string) => api.del<Quote>(`/quote-lines/${lineId}`), onSuccess: onSaved });
  const showCost = q.margin !== null;

  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Regels</h2></div>
      <ErrorBox error={add.error ?? update.error ?? remove.error} />
      <table>
        <thead>
          <tr>
            <th>Omschrijving</th><th className="num">Aantal</th><th className="num">Prijs excl.</th><th className="num">Btw</th><th className="num">Totaal excl.</th>
            {showCost && <th className="num">Kostprijs</th>}
            {editable && <th />}
          </tr>
        </thead>
        <tbody>
          {q.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}<div className="muted mono" style={{ fontSize: 12 }}>{l.productCode} · {PRODUCT_TYPES[l.productType]}</div></td>
              <td className="num">
                {editable ? (
                  <input style={{ width: 70, textAlign: "right" }} defaultValue={formatQty(l.quantity)} onBlur={(e) => {
                    const n = Number(e.target.value.replace(",", "."));
                    if (n > 0 && n !== Number(l.quantity)) update.mutate({ id: l.id, quantity: n });
                  }} />
                ) : `${formatQty(l.quantity)} ${l.unit}`}
              </td>
              <td className="num">{formatCents(l.unitPriceCents)}</td>
              <td className="num">{formatPercent(l.vatRateBasisPoints)}</td>
              <td className="num">{formatCents(l.lineTotalCents)}</td>
              {showCost && <td className="num muted">{l.unitCostCents === null ? "onbekend" : formatCents(Math.round(l.unitCostCents * Number(l.quantity)))}</td>}
              {editable && <td className="num"><button className="btn small danger" onClick={() => remove.mutate(l.id)}>✕</button></td>}
            </tr>
          ))}
          {!q.lines.length && <tr><td colSpan={7} className="empty">Nog geen regels.</td></tr>}
        </tbody>
      </table>
      {editable && (
        <div className="row" style={{ padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
          <select value={productId} onChange={(e) => setProductId(e.target.value)} style={{ flex: 1, minWidth: 240 }}>
            <option value="">Product toevoegen…</option>
            {products.data?.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name} ({formatCents(p.priceCents)})</option>)}
          </select>
          <input value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 70 }} aria-label="Aantal" />
          <button className="btn" disabled={!productId || add.isPending} onClick={() => add.mutate()}>Toevoegen</button>
          {products.data && !products.data.length && <span className="muted" style={{ fontSize: 13 }}>Geen producten met een prijs in dit kanaal.</span>}
        </div>
      )}
    </div>
  );
}

function AcceptModal({ quote, onClose, onSaved }: { quote: Quote; onClose: () => void; onSaved: (q: Quote) => void }) {
  const [name, setName] = useState(customerName(quote.customer));
  const [method, setMethod] = useState("signed_paper");
  const save = useMutation({
    mutationFn: () => api.post<Quote>(`/quotes/${quote.id}/accept`, { acceptedByName: name, method }),
    onSuccess: (q) => {
      onSaved(q);
      onClose();
    },
  });
  return (
    <Modal title="Akkoord registreren" onClose={onClose}>
      <ErrorBox error={save.error} />
      <p className="muted">Na akkoord wordt automatisch een project aangemaakt in de startstatus van de klantreis.</p>
      <Field label="Akkoord gegeven door"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Hoe">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(ACCEPTANCE_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={!name || save.isPending}>Akkoord registreren</button>
      </div>
    </Modal>
  );
}

function RejectModal({ quote, onClose, onSaved }: { quote: Quote; onClose: () => void; onSaved: (q: Quote) => void }) {
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<Quote>(`/quotes/${quote.id}/reject`, { reason: reason || null }),
    onSuccess: (q) => {
      onSaved(q);
      onClose();
    },
  });
  return (
    <Modal title="Offerte afgewezen" onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Reden (optioneel)"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn danger" onClick={() => save.mutate()}>Afgewezen registreren</button>
      </div>
    </Modal>
  );
}
