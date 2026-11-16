import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type QuoteListItem } from "../api";
import { Loading, PageHead } from "../components/ui";
import { customerName, formatAddress, formatCents, formatDate, QUOTE_STATUS } from "../format";
import { nameById, useProductGroups } from "../hooks";

export function QuoteStatusPill({ status }: { status: string }) {
  const s = QUOTE_STATUS[status] ?? { label: status, color: "gray" };
  return <span className={`status ${s.color}`}>{s.label}</span>;
}

export function QuotesTable({ items, showCustomer = true }: { items: QuoteListItem[]; showCustomer?: boolean }) {
  const navigate = useNavigate();
  const groups = useProductGroups();
  return (
    <table>
      <thead>
        <tr><th>Nr.</th>{showCustomer && <th>Klant</th>}<th>Productgroep</th><th>Status</th><th>Geldig tot</th><th className="num">Totaal incl. btw</th></tr>
      </thead>
      <tbody>
        {items.map((q) => (
          <tr key={q.id} className="clickable" onClick={() => navigate(`/offertes/${q.id}`)}>
            <td className="mono">{q.displayNumber}</td>
            {showCustomer && <td><strong>{customerName(q.customer)}</strong><div className="muted">{formatAddress(q.property)}</div></td>}
            <td>{nameById(groups.data, q.productGroupId)}</td>
            <td><QuoteStatusPill status={q.effectiveStatus} /></td>
            <td>{formatDate(q.validUntil)}</td>
            <td className="num">{formatCents(q.totals.totalCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function QuotesPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const params = new URLSearchParams({ limit: "100" });
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  const list = useQuery({ queryKey: ["quotes", params.toString()], queryFn: () => api.get<QuoteListItem[]>(`/quotes?${params}`) });

  return (
    <>
      <PageHead title="Offertes" sub="Nieuwe offertes maak je vanaf de klantkaart." />
      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Zoek op klant, postcode of offertenummer" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 280 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Alle statussen</option>
          {["draft", "sent", "accepted", "rejected", "superseded"].map((s) => <option key={s} value={s}>{QUOTE_STATUS[s]!.label}</option>)}
        </select>
      </div>
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.length ? <div className="empty">Geen offertes gevonden.</div> : <QuotesTable items={list.data} />}
      </div>
    </>
  );
}
