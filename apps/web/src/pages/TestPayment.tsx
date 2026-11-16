import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox } from "../components/ui";
import { formatCents } from "../format";

/** Gesimuleerde betaalpagina (testmodus, zolang er geen Mollie-account is). */
export function TestPaymentPage() {
  const { id } = useParams();
  const info = useQuery({ queryKey: ["test-payment", id], queryFn: () => api.get<{ amountCents: number; status: string; invoiceNumber: string }>(`/public/test-payments/${id}`) });
  const settle = useMutation({
    mutationFn: (result: "paid" | "failed" | "canceled") => api.post(`/public/test-payments/${id}`, { result }),
    onSuccess: () => window.history.back(),
  });
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="alert warning"><strong>Testmodus</strong> — er wordt geen echt geld overgemaakt.</div>
        <ErrorBox error={info.error ?? settle.error} />
        {info.data && (
          <>
            <p>Factuur <span className="mono">{info.data.invoiceNumber}</span></p>
            <p style={{ fontSize: 28, fontWeight: 700, margin: "8px 0 20px" }}>{formatCents(info.data.amountCents)}</p>
            {info.data.status === "pending" ? (
              <div className="row">
                <button className="btn primary" onClick={() => settle.mutate("paid")}>Betaling geslaagd</button>
                <button className="btn danger" onClick={() => settle.mutate("failed")}>Mislukt</button>
                <button className="btn" onClick={() => settle.mutate("canceled")}>Annuleren</button>
              </div>
            ) : <p>Status: {info.data.status}</p>}
          </>
        )}
      </div>
    </div>
  );
}
