import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type InvoiceSummary } from "../api";
import { Field, Loading, PageHead } from "../components/ui";
import { customerName, DUNNING_STAGE, formatCents, formatDate, INVOICE_STATUS, INVOICE_TYPE, todayIso } from "../format";

export function InvoiceStatusPill({ inv }: { inv: Pick<InvoiceSummary, "status" | "dueDate"> }) {
  const overdue = inv.status === "open" && inv.dueDate && inv.dueDate < todayIso();
  const s = overdue ? { label: "Vervallen", color: "red" } : INVOICE_STATUS[inv.status]!;
  return <span className={`status ${s.color}`}>{s.label}</span>;
}

export function InvoicesTable({ items, showCustomer = true }: { items: InvoiceSummary[]; showCustomer?: boolean }) {
  const navigate = useNavigate();
  return (
    <table>
      <thead>
        <tr>
          <th>Nummer</th><th>Soort</th>{showCustomer && <th>Klant</th>}<th>Datum</th><th>Vervalt</th><th>Status</th><th>Aanmaning</th>
          <th className="num">Totaal</th><th className="num">Open</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className="clickable" onClick={() => navigate(`/facturen/${i.id}`)}>
            <td className="mono">{i.number ?? "concept"}</td>
            <td>{INVOICE_TYPE[i.type]}</td>
            {showCustomer && <td>{i.customer ? customerName(i.customer) : "—"}</td>}
            <td>{formatDate(i.invoiceDate)}</td>
            <td>{formatDate(i.dueDate)}</td>
            <td><InvoiceStatusPill inv={i} /></td>
            <td>{i.dunningPaused ? <span className="badge yellow">Gepauzeerd</span> : DUNNING_STAGE[i.dunningStage]}</td>
            <td className="num">{formatCents(i.totalCents)}</td>
            <td className="num">{i.outstandingCents ? formatCents(i.outstandingCents) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InvoicesPage() {
  const [filter, setFilter] = useState("open");
  const params = new URLSearchParams({ limit: "200" });
  if (filter === "overdue") params.set("overdue", "true");
  else if (filter) params.set("status", filter);
  const list = useQuery({ queryKey: ["invoices", params.toString()], queryFn: () => api.get<InvoiceSummary[]>(`/invoices?${params}`) });
  const firstOfMonth = `${todayIso().slice(0, 8)}01`;
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(todayIso());
  const outstanding = (list.data ?? []).reduce((s, i) => s + i.outstandingCents, 0);

  return (
    <>
      <PageHead title="Facturen" sub="Aanbetalings- en eindfacturen worden automatisch gemaakt en verstuurd zodra een project de ingestelde status bereikt." />
      <div className="row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <div className="phase-strip" style={{ margin: 0 }}>
          {[
            ["open", "Openstaand"],
            ["overdue", "Vervallen"],
            ["paid", "Betaald"],
            ["credited", "Gecrediteerd"],
            ["", "Alle"],
          ].map(([k, label]) => (
            <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k!)}>{label}</button>
          ))}
        </div>
        {list.data && filter !== "paid" && filter !== "credited" && <span className="muted">Openstaand: <strong>{formatCents(outstanding)}</strong></span>}
      </div>
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.length ? <div className="empty">Geen facturen.</div> : <InvoicesTable items={list.data} />}
      </div>
      <div className="card">
        <h2>Export voor Exact</h2>
        <p className="muted" style={{ fontSize: 13 }}>CSV met één regel per factuur per btw-tarief (puntkomma-gescheiden). Tot de directe koppeling met Exact er is.</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <Field label="Van"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Tot en met"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <a className="btn" style={{ marginBottom: 12 }} href={`/api/invoices/export.csv?from=${from}&to=${to}`}>Download CSV</a>
        </div>
      </div>
    </>
  );
}
