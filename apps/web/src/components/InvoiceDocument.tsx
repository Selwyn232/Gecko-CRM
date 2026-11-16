import { Fragment } from "react";
import { formatCents, formatDate, formatPercent, formatQty, INVOICE_TYPE } from "../format";

export interface InvoiceDocData {
  number: string | null;
  type: string;
  invoiceDate: string | null;
  dueDate: string | null;
  paymentReference: string | null;
  customer: { name: string; customerNumber: string; email: string | null; address: { street: string; houseNumber: string; houseNumberAddition: string | null; postalCode: string; city: string } | null } | null;
  company: { name: string; street?: string | null; houseNumber?: string | null; postalCode?: string | null; city?: string | null; email?: string | null; phone?: string | null; kvkNumber?: string | null; vatNumber?: string | null; iban?: string | null } | null;
  lines: { description: string; productCode: string | null; quantity: string; unitPriceCents: number; vatRateBasisPoints: number; lineTotalCents: number }[];
  subtotalCents: number;
  vatBreakdown: { rateBasisPoints: number; baseCents: number; vatCents: number }[];
  totalCents: number;
  note?: string | null;
}

/** De factuur zoals de klant hem ziet; gebruikt voor afdrukken (intern) én de openbare factuurpagina. */
export function InvoiceDocument({ d }: { d: InvoiceDocData }) {
  const c = d.company;
  const a = d.customer?.address;
  return (
    <div>
      <header className="print-head">
        <div>
          <div className="brand"><span className="brand-mark">G</span> {c?.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {c?.street && <div>{c.street} {c.houseNumber}, {c.postalCode} {c.city}</div>}
            <div>{[c?.email, c?.phone].filter(Boolean).join(" · ")}</div>
            <div>{[c?.kvkNumber && `KvK ${c.kvkNumber}`, c?.vatNumber && `btw ${c.vatNumber}`].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <h1 style={{ margin: 0 }}>{d.type === "credit" ? "Creditnota" : "Factuur"}</h1>
          <div className="mono">{d.number}</div>
          <div className="muted">{INVOICE_TYPE[d.type]}</div>
        </div>
      </header>
      <section className="print-meta">
        <div>
          <strong>{d.customer?.name}</strong>
          {a && <div>{a.street} {a.houseNumber}{a.houseNumberAddition ? `-${a.houseNumberAddition}` : ""}<br />{a.postalCode.replace(/^(\d{4})([A-Z]{2})$/, "$1 $2")} {a.city}</div>}
        </div>
        <dl className="kv" style={{ gridTemplateColumns: "120px auto" }}>
          <dt>Factuurdatum</dt><dd>{formatDate(d.invoiceDate)}</dd>
          {d.type !== "credit" && <><dt>Vervaldatum</dt><dd>{formatDate(d.dueDate)}</dd></>}
          <dt>Klantnummer</dt><dd>{d.customer?.customerNumber}</dd>
          <dt>Kenmerk</dt><dd className="mono">{d.paymentReference}</dd>
        </dl>
      </section>
      {d.note && <p style={{ marginTop: 16 }}>{d.note}</p>}
      <table className="print-table" style={{ marginTop: 20 }}>
        <thead><tr><th>Omschrijving</th><th className="num">Aantal</th><th className="num">Prijs</th><th className="num">Btw</th><th className="num">Bedrag</th></tr></thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.description}{l.productCode && <div className="muted mono" style={{ fontSize: 11 }}>{l.productCode}</div>}</td>
              <td className="num">{formatQty(l.quantity)}</td>
              <td className="num">{formatCents(l.unitPriceCents)}</td>
              <td className="num">{formatPercent(l.vatRateBasisPoints)}</td>
              <td className="num">{formatCents(l.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="kv print-totals">
        <dt>Subtotaal excl. btw</dt><dd>{formatCents(d.subtotalCents)}</dd>
        {d.vatBreakdown.map((v) => (
          <Fragment key={v.rateBasisPoints}><dt>Btw {formatPercent(v.rateBasisPoints)} over {formatCents(v.baseCents)}</dt><dd>{formatCents(v.vatCents)}</dd></Fragment>
        ))}
        <dt><strong>Totaal incl. btw</strong></dt><dd><strong>{formatCents(d.totalCents)}</strong></dd>
      </dl>
      {d.type !== "credit" && (
        <p style={{ marginTop: 24, fontSize: 13 }}>
          Graag betalen vóór {formatDate(d.dueDate)} op {c?.iban} t.n.v. {c?.name} onder vermelding van <strong>{d.paymentReference}</strong>, of online via de betaallink in de e-mail.
        </p>
      )}
    </div>
  );
}
