import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Product, type Report } from "../api";
import { useAuth } from "../auth";
import { PhotoGrid } from "../components/PhotoUpload";
import { ErrorBox, Field, Loading } from "../components/ui";
import { formatDateTime, REPORT_REVIEW, weekday } from "../format";

export function ReportReviewPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const report = useQuery({ queryKey: ["report", id], queryFn: () => api.get<Report>(`/reports/${id}`) });
  const products = useQuery({ queryKey: ["products", "extra_work"], queryFn: () => api.get<Product[]>("/products?type=extra_work") });
  const [note, setNote] = useState("");
  const review = useMutation({
    mutationFn: (approve: boolean) => api.post<Report & { extraWorkQuoteId: string | null }>(`/reports/${id}/review`, { approve, note: note || null }),
    onSuccess: async (r) => {
      await qc.invalidateQueries();
      if (r.extraWorkQuoteId) navigate(`/offertes/${r.extraWorkQuoteId}`);
    },
  });
  if (report.isLoading) return <Loading />;
  if (!report.data) return <ErrorBox error={report.error} />;
  const r = report.data;
  const a = r.appointment;
  const photos = (r.files ?? []).filter((f) => f.id !== r.customerSignatureFileId);
  const productName = (pid: string) => products.data?.find((p) => p.id === pid);

  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/planning">← Planning</Link> · <Link to={`/projecten/${a.projectId}`}>Project {a.projectNumber}</Link></div>
      <div className="page-head">
        <div>
          <h1>{r.type === "survey" ? "Schouwrapport" : "Opleverrapport"}</h1>
          <p className="row"><span className={`status ${REPORT_REVIEW[r.review]!.color}`}>{REPORT_REVIEW[r.review]!.label}</span><span className="muted">{a.partnerName} · {weekday(a.date)} · ingediend {formatDateTime(r.submittedAt)}</span></p>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Uitkomst</h2>
          <p>{r.positive ? <span className="status green">{r.type === "survey" ? "Technisch haalbaar" : "Installatie werkt"}</span> : <span className="status red">{r.type === "survey" ? "Niet haalbaar" : "Werkt niet"}</span>}</p>
          <dl className="kv">
            <dt>Klant</dt><dd>{[a.customer.firstName, a.customer.lastName].filter(Boolean).join(" ")}</dd>
            <dt>Adres</dt><dd>{a.address}</dd>
            {r.data.checklist && Object.entries(r.data.checklist).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v ? "✓ ja" : "✗ nee"}</dd></Fragment>)}
            {r.data.serialNumbers?.length ? <><dt>Serienummers</dt><dd className="mono">{r.data.serialNumbers.join(", ")}</dd></> : null}
          </dl>
          {r.data.remarks && <p style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{r.data.remarks}</p>}
        </div>
        <div className="card">
          {r.type === "survey" ? (
            <>
              <h2>Voorgesteld meerwerk</h2>
              {!r.data.extraWork?.length ? <p className="muted">Geen meerwerk.</p> : (
                <table>
                  <tbody>
                    {r.data.extraWork.map((x, i) => (
                      <tr key={i}><td><span className="mono">{productName(x.productId)?.code}</span> {productName(x.productId)?.name}{x.note && <div className="muted">{x.note}</div>}</td><td className="num">{x.quantity}×</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              {r.data.extraWork?.length ? <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Bij goedkeuren wordt een meerwerk-offerte (concept) gemaakt met de prijzen uit het verkoopkanaal. Controleer die en verstuur hem ter akkoord.</p> : null}
            </>
          ) : (
            <>
              <h2>Aftekening klant</h2>
              <p>{r.customerSignedName}</p>
              {r.customerSignatureFileId && <img src={`/api/files/${r.customerSignatureFileId}`} alt="Handtekening klant" style={{ maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 }} />}
            </>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Foto's</h2>
        <PhotoGrid files={photos} />
      </div>
      {r.review === "pending" && can("planning.manage") && (
        <div className="card">
          <h2>Beoordelen</h2>
          <ErrorBox error={review.error} />
          <Field label="Opmerking (bij afkeuren zichtbaar voor de partner)"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row">
            <button className="btn primary" disabled={review.isPending} onClick={() => review.mutate(true)}>Goedkeuren</button>
            <button className="btn danger" disabled={review.isPending || note.length < 3} onClick={() => review.mutate(false)}>Afkeuren — partner moet opnieuw indienen</button>
          </div>
        </div>
      )}
      {r.reviewNote && <div className="alert info">Opmerking beoordeling: {r.reviewNote}</div>}
    </>
  );
}
