import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { api, type InvoiceDetail } from "../api";
import { InvoiceDocument } from "../components/InvoiceDocument";
import { Loading } from "../components/ui";

export function InvoicePrintPage() {
  const { id } = useParams();
  const inv = useQuery({ queryKey: ["invoice", id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  useEffect(() => {
    if (inv.data) document.title = `Factuur ${inv.data.number}`;
  }, [inv.data]);
  if (!inv.data) return <Loading />;
  const i = inv.data;
  return (
    <div className="print-page">
      <div className="print-actions no-print"><button className="btn primary" onClick={() => window.print()}>Afdrukken / opslaan als PDF</button></div>
      <InvoiceDocument d={{ ...i, customer: i.customerSnapshot, company: i.companySnapshot }} />
    </div>
  );
}
