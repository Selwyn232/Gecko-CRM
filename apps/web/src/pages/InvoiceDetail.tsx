import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type InvoiceDetail } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal } from "../components/ui";
import { DUNNING_STAGE, formatCents, formatDate, formatDateTime, formatPercent, formatQty, INVOICE_TYPE, parseEuro, PAYMENT_METHOD, todayIso } from "../format";
import { InvoiceStatusPill } from "./Invoices";

const TEMPLATE: Record<string, string> = {
  "invoice.deposit": "Aanbetalingsfactuur",
  "invoice.final": "Eindfactuur",
  "invoice.credit": "Creditnota",
  "dunning.reminder": "Herinnering",
  "dunning.formal_notice": "14-dagenbrief",
};

export function InvoiceDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const inv = useQuery({ queryKey: ["invoice", id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  const [paying, setPaying] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["invoice", id] });
  const send = useMutation({ mutationFn: () => api.post<{ emailStatus: string; url: string | null; email: string }>(`/invoices/${id}/send`), onSuccess: refresh });
  const pause = useMutation({ mutationFn: (reason: string | null) => api.post(`/invoices/${id}/dunning-pause`, { reason }), onSuccess: refresh });

  if (inv.isLoading) return <Loading />;
  if (!inv.data) return <ErrorBox error={inv.error ?? "Niet gevonden"} />;
  const i = inv.data;
  const manage = can("invoices.manage");
  const snap = i.customerSnapshot;

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link to="/facturen">← Facturen</Link>
        {i.customer && <> · <Link to={`/klanten/${i.customer.id}`}>{snap?.name}</Link></>}
        {i.projectId && <> · <Link to={`/projecten/${i.projectId}`}>Project</Link></>}
      </div>
      <div className="page-head">
        <div>
          <h1>{INVOICE_TYPE[i.type]} {i.number}</h1>
          <p className="row"><InvoiceStatusPill inv={i} /><span className="muted">{formatDate(i.invoiceDate)} · vervalt {formatDate(i.dueDate)}</span></p>
        </div>
        <div className="row">
          <a className="btn" href={`/facturen/${i.id}/print`} target="_blank" rel="noreferrer">Afdrukken / PDF</a>
          {manage && i.status === "open" && <button className="btn" onClick={() => send.mutate()}>Opnieuw versturen</button>}
          {manage && i.status === "open" && i.type !== "credit" && <button className="btn primary" onClick={() => setPaying(true)}>Betaling registreren</button>}
          {manage && (i.status === "open" || i.status === "paid") && i.type !== "credit" && <button className="btn danger" onClick={() => setCrediting(true)}>Crediteren</button>}
        </div>
      </div>
      <ErrorBox error={send.error ?? pause.error} />
      {send.data && (
        <div className={`alert ${send.data.emailStatus === "sent" ? "info" : "warning"}`}>
          {send.data.emailStatus === "sent" ? `Verstuurd naar ${send.data.email}.` : <>Niet per e-mail verstuurd. Betaallink: <a href={send.data.url!}>{send.data.url}</a></>}
        </div>
      )}
      {i.note && <div className="alert info">{i.note}</div>}
      {i.creditedInvoiceId && <p className="muted">Crediteert <Link to={`/facturen/${i.creditedInvoiceId}`}>de oorspronkelijke factuur</Link>.</p>}

      <div className="grid-2">
        <div className="card">
          <h2>Klant</h2>
          <dl className="kv">
            <dt>Naam</dt><dd>{snap?.name} <span className="muted mono">{snap?.customerNumber}</span></dd>
            <dt>Adres</dt><dd>{snap?.address ? `${snap.address.street} ${snap.address.houseNumber}${snap.address.houseNumberAddition ? `-${snap.address.houseNumberAddition}` : ""}, ${snap.address.postalCode} ${snap.address.city}` : "—"}</dd>
            <dt>E-mail</dt><dd>{snap?.email ?? "—"}</dd>
            <dt>Betalingskenmerk</dt><dd className="mono">{i.paymentReference}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Bedragen</h2>
          <dl className="kv">
            <dt>Subtotaal excl. btw</dt><dd style={{ textAlign: "right" }}>{formatCents(i.subtotalCents)}</dd>
            {i.vatBreakdown.map((v) => (
              <Fragment key={v.rateBasisPoints}><dt>Btw {formatPercent(v.rateBasisPoints)}</dt><dd style={{ textAlign: "right" }}>{formatCents(v.vatCents)}</dd></Fragment>
            ))}
            <dt><strong>Totaal</strong></dt><dd style={{ textAlign: "right" }}><strong>{formatCents(i.totalCents)}</strong></dd>
            <dt>Betaald</dt><dd style={{ textAlign: "right" }}>{formatCents(i.paidCents)}</dd>
            <dt><strong>Openstaand</strong></dt><dd style={{ textAlign: "right" }}><strong>{formatCents(i.outstandingCents)}</strong></dd>
          </dl>
        </div>
      </div>

      <div className="card flush">
        <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Regels</h2></div>
        <table>
          <thead><tr><th>Code</th><th>Omschrijving</th><th className="num">Aantal</th><th className="num">Prijs</th><th className="num">Btw</th><th className="num">Bedrag</th></tr></thead>
          <tbody>
            {i.lines.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.productCode ?? ""}</td>
                <td>{l.description}</td>
                <td className="num">{formatQty(l.quantity)}</td>
                <td className="num">{formatCents(l.unitPriceCents)}</td>
                <td className="num">{formatPercent(l.vatRateBasisPoints)}</td>
                <td className="num">{formatCents(l.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-2">
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Betalingen</h2></div>
          {!i.payments.length ? <div className="empty">Nog geen betalingen.</div> : (
            <table>
              <thead><tr><th>Datum</th><th>Wijze</th><th>Status</th><th className="num">Bedrag</th></tr></thead>
              <tbody>
                {i.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDateTime(p.paidAt ?? p.createdAt)}</td>
                    <td>{PAYMENT_METHOD[p.method]}{p.provider === "test" && <span className="badge yellow" style={{ marginLeft: 6 }}>test</span>}</td>
                    <td>{p.status === "paid" ? <span className="status green">Betaald</span> : <span className="status">{p.status}</span>}</td>
                    <td className="num">{formatCents(p.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Herinneringen en aanmaningen</h2>
            {manage && i.status === "open" && i.type !== "credit" && (
              i.dunningPaused
                ? <button className="btn small" onClick={() => pause.mutate(null)}>Hervatten</button>
                : <button className="btn small" onClick={() => { const r = prompt("Reden voor pauzeren (bv. klacht in behandeling)"); if (r) pause.mutate(r); }}>Pauzeren</button>
            )}
          </div>
          {i.dunningPaused && <div className="alert warning">Gepauzeerd: {i.dunningPaused}</div>}
          {!i.dunning.length ? <p className="muted">Nog niets verstuurd.</p> : (
            <ul className="timeline">
              {i.dunning.map((d) => (
                <li key={d.id}>
                  <strong>{DUNNING_STAGE[d.stage]}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {formatDateTime(d.createdAt)} · open {formatCents(d.outstandingCents)}
                    {d.deadline && ` · uiterlijk ${formatDate(d.deadline)}`}
                    {d.collectionCostsCents != null && ` · incassokosten ${formatCents(d.collectionCostsCents)}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {i.emails.length > 0 && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>E-mails</h2></div>
          <table>
            <thead><tr><th>Tijdstip</th><th>Bericht</th><th>Aan</th><th>Status</th></tr></thead>
            <tbody>
              {i.emails.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{formatDateTime(e.createdAt)}</td>
                  <td>{TEMPLATE[e.template] ?? e.template}</td>
                  <td>{e.toAddress}</td>
                  <td>{e.status === "sent" ? <span className="status green">Verstuurd</span> : e.status === "failed" ? <span className="status red">Mislukt</span> : <span className="status yellow">Niet verstuurd</span>}{e.error && <div className="muted" style={{ fontSize: 12 }}>{e.error}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paying && <PaymentModal invoice={i} onClose={() => setPaying(false)} />}
      {crediting && <CreditModal invoice={i} onClose={() => setCrediting(false)} />}
    </>
  );
}

function PaymentModal({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState((invoice.outstandingCents / 100).toFixed(2).replace(".", ","));
  const [method, setMethod] = useState("bank_transfer");
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const cents = parseEuro(amount);
      if (!cents) throw new Error("Ongeldig bedrag");
      return api.post(`/invoices/${invoice.id}/payments`, { amountCents: cents, method, paidAt: `${date}T12:00:00Z`, note: note || null });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
      onClose();
    },
  });
  return (
    <Modal title="Betaling registreren" onClose={onClose}>
      <ErrorBox error={save.error} />
      <div className="grid-2">
        <Field label="Bedrag (€)"><input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Ontvangen op"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Wijze">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="bank_transfer">Overschrijving</option>
          <option value="warmtefonds">Warmtefonds</option>
          <option value="other">Overig</option>
        </select>
      </Field>
      <Field label="Notitie"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="bv. bankmutatie-kenmerk" /></Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Registreren</button>
      </div>
    </Modal>
  );
}

function CreditModal({ invoice, onClose }: { invoice: InvoiceDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<InvoiceDetail>(`/invoices/${invoice.id}/credit`, { reason }),
    onSuccess: async (credit) => {
      await qc.invalidateQueries({ queryKey: ["invoice", invoice.id] });
      await qc.invalidateQueries({ queryKey: ["invoices"] });
      onClose();
      window.location.href = `/facturen/${credit.id}`;
    },
  });
  return (
    <Modal title={`Factuur ${invoice.number} crediteren`} onClose={onClose}>
      <ErrorBox error={save.error} />
      <p className="muted">Er wordt een creditnota gemaakt die deze factuur volledig tegenboekt. {invoice.paidCents > 0 && <strong>Er is al {formatCents(invoice.paidCents)} betaald: terugbetalen gebeurt handmatig.</strong>}</p>
      <Field label="Reden (komt op de creditnota)"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn danger" disabled={reason.length < 3 || save.isPending} onClick={() => save.mutate()}>Creditnota maken</button>
      </div>
    </Modal>
  );
}
