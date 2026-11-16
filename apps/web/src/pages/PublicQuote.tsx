import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type QuoteTotals } from "../api";
import { ErrorBox, Field } from "../components/ui";
import { formatCents, formatDate, formatDateTime, formatPercent, formatQty } from "../format";

interface PublicQuote {
  quote: {
    displayNumber: string;
    status: string;
    productGroup: string;
    customerName: string;
    address: string;
    priceDate: string | null;
    validUntil: string | null;
    customerNote: string | null;
    advisorName: string | null;
    lines: { description: string; quantity: string; unit: string; unitPriceCents: number; vatRateBasisPoints: number; lineTotalCents: number }[];
    totals: QuoteTotals;
    acceptedAt: string | null;
    acceptedByName: string | null;
  };
  email: string;
  canAccept: boolean;
  company: { name: string; email: string | null; phone: string | null };
  paymentTerms: string;
  withdrawal: string;
}

/** Pagina voor de klant (zonder login): offerte bekijken en digitaal accepteren met een code per e-mail. */
export function PublicQuotePage() {
  const { token } = useParams();
  const data = useQuery({ queryKey: ["public-quote", token], queryFn: () => api.get<PublicQuote>(`/public/quotes/${token}`), retry: false });
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = data.data ? `Offerte ${data.data.quote.displayNumber}` : "Offerte";
  }, [data.data]);

  if (data.isLoading) return <div className="auth-wrap muted">Laden…</div>;
  if (!data.data) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card"><ErrorBox error={data.error} /></div>
      </div>
    );
  }
  const { quote: q, company } = data.data;

  return (
    <div className="public-page">
      <header className="public-head">
        <div className="brand"><span className="brand-mark">G</span> {company.name}</div>
        <div className="muted">Offerte <span className="mono">{q.displayNumber}</span></div>
      </header>

      {done || q.status === "accepted" ? (
        <div className="card">
          <h1>Bedankt!</h1>
          <p>
            {done ? "U heeft de offerte geaccepteerd." : `Deze offerte is op ${formatDateTime(q.acceptedAt)} geaccepteerd door ${q.acceptedByName}.`} U ontvangt een
            bevestiging per e-mail. Wij nemen binnenkort contact met u op over de volgende stappen.
          </p>
        </div>
      ) : !data.data.canAccept ? (
        <div className="alert warning">
          Deze offerte kan niet meer worden geaccepteerd{q.status === "expired" ? ` (verlopen op ${formatDate(q.validUntil)})` : ""}. Neem contact met ons op
          {company.email ? ` via ${company.email}` : ""}{company.phone ? ` of ${company.phone}` : ""}.
        </div>
      ) : null}

      <div className="card">
        <h1 style={{ marginBottom: 8 }}>{q.productGroup}</h1>
        <dl className="kv">
          <dt>Voor</dt><dd>{q.customerName}</dd>
          <dt>Adres</dt><dd>{q.address}</dd>
          <dt>Datum</dt><dd>{formatDate(q.priceDate)}</dd>
          <dt>Geldig tot en met</dt><dd>{formatDate(q.validUntil)}</dd>
          {q.advisorName && <><dt>Uw adviseur</dt><dd>{q.advisorName}</dd></>}
        </dl>
        {q.customerNote && <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{q.customerNote}</p>}
      </div>

      <div className="card flush">
        <table>
          <thead><tr><th>Omschrijving</th><th className="num">Aantal</th><th className="num">Btw</th><th className="num">Bedrag excl. btw</th></tr></thead>
          <tbody>
            {q.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td>
                <td className="num">{formatQty(l.quantity)}</td>
                <td className="num">{formatPercent(l.vatRateBasisPoints)}</td>
                <td className="num">{formatCents(l.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="kv print-totals" style={{ padding: "0 20px 16px" }}>
          <dt>Subtotaal excl. btw</dt><dd>{formatCents(q.totals.subtotalCents)}</dd>
          {q.totals.vat.map((v) => (
            <Fragment key={v.rateBasisPoints}><dt>Btw {formatPercent(v.rateBasisPoints)}</dt><dd>{formatCents(v.vatCents)}</dd></Fragment>
          ))}
          <dt><strong>Totaal incl. btw</strong></dt><dd><strong>{formatCents(q.totals.totalCents)}</strong></dd>
        </dl>
      </div>

      <div className="card" style={{ fontSize: 14 }}>
        <p>{data.data.paymentTerms}</p>
        <p style={{ margin: 0 }}>{data.data.withdrawal}</p>
      </div>

      {data.data.canAccept && !done && <AcceptForm token={token!} email={data.data.email} defaultName={q.customerName} onDone={() => setDone(true)} />}
    </div>
  );
}

function AcceptForm({ token, email, defaultName, onDone }: { token: string; email: string; defaultName: string; onDone: () => void }) {
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultName);
  const [agree, setAgree] = useState(false);
  const requestCode = useMutation({ mutationFn: () => api.post(`/public/quotes/${token}/code`), onSuccess: () => setCodeSent(true) });
  const accept = useMutation({
    mutationFn: () => api.post(`/public/quotes/${token}/accept`, { code: code.trim(), name, agreeTerms: agree }),
    onSuccess: onDone,
  });

  return (
    <div className="card">
      <h2>Offerte accepteren</h2>
      <ErrorBox error={requestCode.error ?? accept.error} />
      {!codeSent ? (
        <>
          <p>Om zeker te weten dat u het bent, sturen we een code naar <strong>{email}</strong>.</p>
          <button className="btn primary" onClick={() => requestCode.mutate()} disabled={requestCode.isPending}>Stuur mij een code</button>
        </>
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); accept.mutate(); }}>
          <p className="muted">We hebben een code van 6 cijfers gestuurd naar {email}. Niet ontvangen? Kijk in uw spammap of <button type="button" className="btn small" onClick={() => requestCode.mutate()}>stuur opnieuw</button></p>
          <div className="grid-2">
            <Field label="Code uit de e-mail"><input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus /></Field>
            <Field label="Uw volledige naam"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>Ik ga akkoord met deze offerte en de betalingsvoorwaarden, en heb de informatie over de bedenktijd gelezen.</span>
          </label>
          <button className="btn primary" style={{ marginTop: 12 }} disabled={!agree || accept.isPending}>Offerte accepteren</button>
        </form>
      )}
    </div>
  );
}
