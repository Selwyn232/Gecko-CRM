import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect } from "react";
import { useParams } from "react-router-dom";
import { api, type Quote } from "../api";
import { Loading } from "../components/ui";
import { customerName, formatAddress, formatCents, formatDate, formatPercent, formatQty, QUOTE_STATUS } from "../format";
import { useOrganizations } from "../hooks";

/** Afdrukbare offerte. Via de printfunctie van de browser ook als PDF op te slaan. */
export function QuotePrintPage() {
  const { id } = useParams();
  const quote = useQuery({ queryKey: ["quote", id], queryFn: () => api.get<Quote>(`/quotes/${id}`) });
  const orgs = useOrganizations();
  const gecko = orgs.data?.find((o) => o.type === "gecko");

  useEffect(() => {
    document.title = quote.data ? `Offerte ${quote.data.displayNumber}` : "Offerte";
  }, [quote.data]);

  if (quote.isLoading || !quote.data) return <Loading />;
  const q = quote.data;

  return (
    <div className="print-page">
      <div className="print-actions no-print">
        <button className="btn primary" onClick={() => window.print()}>Afdrukken / opslaan als PDF</button>
        {q.status === "draft" && <span className="badge yellow">Concept — nog niet definitief</span>}
      </div>
      <header className="print-head">
        <div>
          <div className="brand"><span className="brand-mark">G</span> {gecko?.name ?? "Gecko BV"}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {gecko?.street && <div>{gecko.street} {gecko.houseNumber}, {gecko.postalCode} {gecko.city}</div>}
            <div>{[gecko?.email, gecko?.phone].filter(Boolean).join(" · ")}</div>
            <div>{[gecko?.kvkNumber && `KvK ${gecko.kvkNumber}`, gecko?.vatNumber && `btw ${gecko.vatNumber}`].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <h1 style={{ margin: 0 }}>Offerte</h1>
          <div className="mono">{q.displayNumber}</div>
          {q.status !== "sent" && q.status !== "accepted" && <div className="muted">{QUOTE_STATUS[q.effectiveStatus]?.label}</div>}
        </div>
      </header>

      <section className="print-meta">
        <div>
          <strong>{customerName(q.customer)}</strong>
          <div>{formatAddress(q.property)}</div>
          {q.customer.email && <div>{q.customer.email}</div>}
        </div>
        <dl className="kv" style={{ gridTemplateColumns: "110px auto" }}>
          <dt>Datum</dt><dd>{formatDate(q.priceDate ?? q.createdAt)}</dd>
          <dt>Geldig tot</dt><dd>{q.validUntil ? formatDate(q.validUntil) : "—"}</dd>
          <dt>Klantnummer</dt><dd>{q.customer.displayNumber}</dd>
          {q.advisor && <><dt>Adviseur</dt><dd>{q.advisor.name}</dd></>}
        </dl>
      </section>

      <h2 style={{ marginTop: 24 }}>{q.productGroup.name}</h2>
      {q.customerNote && <p style={{ whiteSpace: "pre-wrap" }}>{q.customerNote}</p>}

      <table className="print-table">
        <thead><tr><th>Omschrijving</th><th className="num">Aantal</th><th className="num">Prijs</th><th className="num">Btw</th><th className="num">Bedrag</th></tr></thead>
        <tbody>
          {q.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="num">{formatQty(l.quantity)}</td>
              <td className="num">{formatCents(l.unitPriceCents)}</td>
              <td className="num">{formatPercent(l.vatRateBasisPoints)}</td>
              <td className="num">{formatCents(l.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="kv print-totals">
        <dt>Subtotaal excl. btw</dt><dd>{formatCents(q.totals.subtotalCents)}</dd>
        {q.totals.vat.map((v) => (
          <Fragment key={v.rateBasisPoints}><dt>Btw {formatPercent(v.rateBasisPoints)}</dt><dd>{formatCents(v.vatCents)}</dd></Fragment>
        ))}
        <dt><strong>Totaal incl. btw</strong></dt><dd><strong>{formatCents(q.totals.totalCents)}</strong></dd>
      </dl>

      <section style={{ marginTop: 24, fontSize: 13 }}>
        <p>Betaling: 70% na het inplannen van de schouw, vóór de schouw te voldoen; 30% en eventueel overeengekomen meerwerk na werkende oplevering.</p>
      </section>

      <section className="print-sign">
        <div>Voor akkoord (naam en handtekening)<div className="sign-line" /></div>
        <div>Datum<div className="sign-line" /></div>
      </section>
    </div>
  );
}
