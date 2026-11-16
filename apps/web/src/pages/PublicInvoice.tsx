import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { InvoiceDocument, type InvoiceDocData } from "../components/InvoiceDocument";
import { ErrorBox } from "../components/ui";
import { formatCents } from "../format";

type PublicInvoice = InvoiceDocData & { status: string; paidCents: number; outstandingCents: number };

/** Factuur voor de klant (zonder login) met betaalknop. */
export function PublicInvoicePage() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const inv = useQuery({ queryKey: ["public-invoice", token], queryFn: () => api.get<PublicInvoice>(`/public/invoices/${token}`), retry: false, refetchInterval: params.get("betaald") ? 3000 : false });
  const pay = useMutation({
    mutationFn: () => api.post<{ checkoutUrl: string }>(`/public/invoices/${token}/pay`),
    onSuccess: (r) => {
      window.location.href = r.checkoutUrl;
    },
  });
  useEffect(() => {
    if (inv.data) document.title = `Factuur ${inv.data.number}`;
  }, [inv.data]);

  if (inv.isLoading) return <div className="auth-wrap muted">Laden…</div>;
  if (!inv.data) return <div className="auth-wrap"><div className="card auth-card"><ErrorBox error={inv.error} /></div></div>;
  const d = inv.data;

  return (
    <div className="public-page">
      {d.status === "paid" ? (
        <div className="alert info">Deze factuur is betaald. Hartelijk dank!</div>
      ) : d.status === "open" && d.type !== "credit" ? (
        <div className="card">
          {params.get("betaald") && <div className="alert info">Bedankt! We verwerken uw betaling; deze pagina wordt vanzelf bijgewerkt.</div>}
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="muted">Te betalen</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCents(d.outstandingCents)}</div>
            </div>
            <button className="btn primary" onClick={() => pay.mutate()} disabled={pay.isPending}>Betalen met iDEAL</button>
          </div>
          <ErrorBox error={pay.error} />
        </div>
      ) : null}
      <div className="card">
        <InvoiceDocument d={d} />
      </div>
    </div>
  );
}
