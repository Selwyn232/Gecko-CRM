import { Fragment } from "react";
import { formatCents, formatDate, formatPercent } from "../format";

export interface SelfBillingDetail {
  id: string;
  number: string | null;
  kind: "sales_fee" | "installation";
  status: "draft" | "final" | "paid";
  partnerOrganizationId: string;
  partnerName: string;
  invoiceDate: string | null;
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  vatMode: "normal" | "reverse_charge";
  paidAt: string | null;
  sentAt: string | null;
  createdAt: string;
  vatBreakdown: { rateBasisPoints: number; baseCents: number; vatCents: number }[];
  partnerSnapshot: Party;
  companySnapshot: Party;
  lines: {
    id: string;
    kind: "fee" | "installation" | "extra_work" | "penalty" | "correction";
    projectId: string | null;
    advisorName: string | null;
    description: string;
    basisCents: number | null;
    feeBasisPoints: number | null;
    amountCents: number;
    vatRateBasisPoints: number;
  }[];
}
interface Party {
  name: string;
  street?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  kvkNumber?: string | null;
  vatNumber?: string | null;
  iban?: string | null;
  email?: string | null;
}

export const SB_KIND: Record<string, string> = { sales_fee: "Fee verkooppartner", installation: "Installatie" };
export const SB_LINE: Record<string, string> = { fee: "Fee", installation: "Installatie", extra_work: "Meerwerk", penalty: "Boete", correction: "Correctie" };

const PartyBlock = ({ p, title }: { p: Party; title: string }) => (
  <div style={{ fontSize: 13 }}>
    <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</div>
    <strong>{p.name}</strong>
    {p.street && <div>{p.street} {p.houseNumber}<br />{p.postalCode} {p.city}</div>}
    <div>{[p.kvkNumber && `KvK ${p.kvkNumber}`, p.vatNumber && `btw ${p.vatNumber}`].filter(Boolean).join(" · ")}</div>
    {p.iban && <div>IBAN {p.iban}</div>}
  </div>
);

/**
 * Selfbillingfactuur: opgemaakt door Gecko (afnemer) namens de partner (leverancier).
 * Wettelijk vereist: vermelding "Factuur uitgereikt door afnemer" en bij verlegging "Btw verlegd".
 */
export function SelfBillingDocument({ d, onRemoveLine }: { d: SelfBillingDetail; onRemoveLine?: (lineId: string) => void }) {
  const isFee = d.kind === "sales_fee";
  return (
    <div>
      <header className="print-head">
        <PartyBlock p={d.partnerSnapshot} title="Leverancier" />
        <div style={{ textAlign: "right" }}>
          <h1 style={{ margin: 0 }}>{d.status === "draft" ? "Concept-selfbillingfactuur" : "Factuur"}</h1>
          <div className="mono">{d.number ?? "(nog geen nummer)"}</div>
          <div className="muted">{SB_KIND[d.kind]}</div>
        </div>
      </header>
      <section className="print-meta">
        <PartyBlock p={d.companySnapshot} title="Afnemer" />
        <dl className="kv" style={{ gridTemplateColumns: "120px auto" }}>
          <dt>Factuurdatum</dt><dd>{formatDate(d.invoiceDate)}</dd>
          <dt>Btw</dt><dd>{d.vatMode === "reverse_charge" ? "Verlegd" : "Volgens tarief"}</dd>
        </dl>
      </section>
      <table className="print-table" style={{ marginTop: 20 }}>
        <thead>
          <tr>
            <th>Omschrijving</th>
            {isFee && <th>Adviseur</th>}
            {isFee && <th className="num">Grondslag</th>}
            {isFee && <th className="num">Fee</th>}
            <th className="num">Btw</th>
            <th className="num">Bedrag</th>
            {onRemoveLine && <th className="no-print" />}
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td>
                <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>{SB_LINE[l.kind]}</span>
                {l.description}
              </td>
              {isFee && <td>{l.advisorName ?? "—"}</td>}
              {isFee && <td className="num">{formatCents(l.basisCents)}</td>}
              {isFee && <td className="num">{l.feeBasisPoints != null ? formatPercent(l.feeBasisPoints) : "—"}</td>}
              <td className="num">{l.kind === "penalty" ? "n.v.t." : d.vatMode === "reverse_charge" ? "verlegd" : formatPercent(l.vatRateBasisPoints)}</td>
              <td className="num">{formatCents(l.amountCents)}</td>
              {onRemoveLine && <td className="no-print"><button className="btn small" title="Regel weghalen; de post komt terug bij Uit te betalen" onClick={() => onRemoveLine(l.id)}>×</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="kv print-totals">
        <dt>Subtotaal excl. btw</dt><dd>{formatCents(d.subtotalCents)}</dd>
        {d.vatMode === "reverse_charge" ? (
          <><dt>Btw verlegd</dt><dd>{formatCents(0)}</dd></>
        ) : (
          d.vatBreakdown.filter((v) => v.rateBasisPoints > 0).map((v) => (
            <Fragment key={v.rateBasisPoints}><dt>Btw {formatPercent(v.rateBasisPoints)} over {formatCents(v.baseCents)}</dt><dd>{formatCents(v.vatCents)}</dd></Fragment>
          ))
        )}
        <dt><strong>Totaal</strong></dt><dd><strong>{formatCents(d.totalCents)}</strong></dd>
      </dl>
      <p style={{ marginTop: 24, fontSize: 13 }}>
        <strong>Factuur uitgereikt door afnemer.</strong> Opgemaakt door {d.companySnapshot.name} op grond van de zelffactureringsovereenkomst met {d.partnerSnapshot.name}.
        {d.vatMode === "reverse_charge" && <> <strong>Btw verlegd</strong>{d.companySnapshot.vatNumber && <> naar {d.companySnapshot.vatNumber}</>}.</>}
        {d.lines.some((l) => l.kind === "penalty") && <> Boetes zijn schadevergoeding en vallen buiten de btw.</>}
        {d.partnerSnapshot.iban && <> Het totaalbedrag wordt overgemaakt naar {d.partnerSnapshot.iban}.</>}
      </p>
    </div>
  );
}
