import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { InvoiceDocument, type InvoiceDocData } from "../components/InvoiceDocument";
import { ErrorBox, Field, Loading, Modal } from "../components/ui";
import { formatCents, formatDate, INVOICE_TYPE } from "../format";

interface PortalProject {
  id: string;
  number: string;
  productGroup: string;
  address: string;
  status: { name: string; phase: string; isFinal: boolean; canceled: boolean };
  phases: string[];
  appointments: { id: string; type: "survey" | "installation" | "service"; date: string; days: number; timeWindow: string; arrival?: string | null; status: string; partnerName: string; canReschedule: boolean }[];
  quotes: { id: string; number: string; kind: "main" | "extra_work"; status: string; validUntil: string | null; acceptedAt: string | null; totalCents: number }[];
  invoices: { id: string; number: string; type: string; status: string; invoiceDate: string | null; dueDate: string | null; totalCents: number; outstandingCents: number; paymentReference: string }[];
}
interface Payment { onlinePayment: boolean; iban: string | null; companyName: string }
interface Overview extends Payment { name: string; email: string; rescheduleWindowDays: number; projects: PortalProject[] }

const WINDOW: Record<string, string> = { morning: "ochtend (8:00–12:00)", afternoon: "middag (12:00–17:00)", day: "hele dag" };
const TYPE: Record<string, string> = { survey: "Schouw", installation: "Installatie" };
const longDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });

function Shell({ children, onLogout }: { children: React.ReactNode; onLogout?: () => void }) {
  return (
    <div className="public-page">
      <div className="public-head">
        <div className="brand"><span className="brand-mark">G</span> Mijn Gecko</div>
        {onLogout && <button className="btn small" onClick={onLogout}>Uitloggen</button>}
      </div>
      {children}
    </div>
  );
}

/** /mijn — overzicht, of het inlogformulier als er geen sessie is. */
export function CustomerPortalPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const overview = useQuery({ queryKey: ["portal"], queryFn: () => api.get<Overview>("/public/portal/overview"), retry: false });
  useEffect(() => {
    document.title = "Mijn Gecko";
  }, []);
  const logout = async () => {
    await api.post("/public/portal/logout");
    qc.removeQueries({ queryKey: ["portal"] });
    window.location.replace("/mijn");
  };
  if (overview.isLoading) return <Shell><Loading /></Shell>;
  if (overview.error instanceof ApiError && overview.error.status === 401) return <PortalLogin />;
  if (!overview.data) return <Shell><ErrorBox error={overview.error} /></Shell>;
  const o = overview.data;
  return (
    <Shell onLogout={logout}>
      <h1 style={{ margin: "0 0 4px" }}>Welkom{o.name ? `, ${o.name}` : ""}</h1>
      <p className="muted" style={{ marginTop: 0 }}>Hier volgt u uw project: status, afspraken, offertes en facturen.</p>
      {params.get("betaald") && <div className="alert info">Bedankt! We verwerken uw betaling; dit kan een paar minuten duren.</div>}
      {!o.projects.length && <div className="card empty">Er zijn nog geen projecten op uw naam.</div>}
      {o.projects.map((p) => <ProjectCard key={p.id} p={p} windowDays={o.rescheduleWindowDays} payment={o} />)}
      <p className="muted" style={{ fontSize: 13 }}>Vragen? Beantwoord een van onze e-mails; we helpen u graag.</p>
    </Shell>
  );
}

function PortalLogin() {
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => api.post("/public/portal/login", { email }) });
  return (
    <Shell>
      <div className="card" style={{ maxWidth: 440, margin: "24px auto" }}>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>Inloggen op Mijn Gecko</h1>
        {send.isSuccess ? (
          <p>Als <strong>{email}</strong> bij ons bekend is, ontvangt u binnen een paar minuten een e-mail met een inloglink. Kijk ook in uw spam.</p>
        ) : (
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
            <p className="muted">Vul het e-mailadres in dat u bij ons gebruikt. U ontvangt een link om in te loggen; een wachtwoord is niet nodig.</p>
            <ErrorBox error={send.error} />
            <Field label="E-mailadres"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <button className="btn primary" disabled={send.isPending} style={{ width: "100%" }}>Stuur inloglink</button>
          </form>
        )}
      </div>
    </Shell>
  );
}

/** /mijn/inloggen/:token — link uit de e-mail inwisselen. */
export function PortalRedeemPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    api
      .post("/public/portal/session", { token })
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ["portal"] });
        navigate("/mijn", { replace: true });
      })
      .catch(setError);
  }, [token, navigate, qc]);
  return (
    <Shell>
      {error ? (
        <div className="card"><ErrorBox error={error} /><Link className="btn" to="/mijn">Nieuwe inloglink aanvragen</Link></div>
      ) : (
        <Loading />
      )}
    </Shell>
  );
}

function Phases({ p }: { p: PortalProject }) {
  if (p.status.canceled) return <div className="alert warning">Dit project is geannuleerd.</div>;
  const current = p.status.isFinal ? p.phases.length : Math.max(0, p.phases.indexOf(p.status.phase));
  return (
    <ol className="portal-steps" aria-label="Voortgang">
      {p.phases.map((ph, i) => (
        <li key={ph} className={i < current ? "done" : i === current ? "current" : ""}>
          <span className="dot">{i < current ? "✓" : i + 1}</span>
          <span>{ph}</span>
        </li>
      ))}
    </ol>
  );
}

function ProjectCard({ p, windowDays, payment }: { p: PortalProject; windowDays: number; payment: Payment }) {
  const [invoice, setInvoice] = useState<string | null>(null);
  const [moving, setMoving] = useState<PortalProject["appointments"][number] | null>(null);
  const quoteLink = useMutation({
    mutationFn: (id: string) => api.post<{ url: string }>(`/public/portal/quotes/${id}/link`),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
  });
  const pay = useMutation({
    mutationFn: (id: string) => api.post<{ checkoutUrl: string }>(`/public/portal/invoices/${id}/pay`),
    onSuccess: (r) => {
      window.location.href = r.checkoutUrl;
    },
  });
  const upcoming = p.appointments.filter((a) => a.status === "planned");
  const openQuotes = p.quotes.filter((q) => q.status === "sent");
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>{p.productGroup}</h2>
          <div className="muted" style={{ fontSize: 13 }}>{p.address} · project {p.number}</div>
        </div>
        <span className="badge green">{p.status.name}</span>
      </div>
      <Phases p={p} />
      <ErrorBox error={quoteLink.error ?? pay.error} />

      {openQuotes.map((q) => (
        <div key={q.id} className="alert warning row" style={{ justifyContent: "space-between" }}>
          <span>{q.kind === "extra_work" ? "Er staat meerwerk voor u klaar" : "Uw offerte wacht op akkoord"} ({q.number}, {formatCents(q.totalCents)}{q.validUntil && `, geldig tot ${formatDate(q.validUntil)}`}).</span>
          <button className="btn primary small" disabled={quoteLink.isPending} onClick={() => quoteLink.mutate(q.id)}>Bekijken en accepteren</button>
        </div>
      ))}

      <h3>Afspraken</h3>
      {!upcoming.length ? (
        <p className="muted">Er staan geen afspraken gepland. Zodra er een datum is, ziet u die hier en krijgt u een e-mail.</p>
      ) : (
        upcoming.map((a) => (
          <div key={a.id} className="portal-row">
            <div>
              <strong>{TYPE[a.type]}</strong> — {longDate(a.date)}, {a.arrival ?? WINDOW[a.timeWindow]}{a.days > 1 && ` (${a.days} dagen)`}
              <div className="muted" style={{ fontSize: 13 }}>Door {a.partnerName}</div>
            </div>
            {a.canReschedule ? (
              <button className="btn small" onClick={() => setMoving(a)}>Verzetten</button>
            ) : (
              <span className="muted" style={{ fontSize: 12 }} title={`Verzetten kan tot ${windowDays} dagen vooraf`}>Verzetten via ons</span>
            )}
          </div>
        ))
      )}

      {p.invoices.length > 0 && (
        <>
          <h3>Facturen</h3>
          {p.invoices.map((i) => (
            <div key={i.id} className="portal-row">
              <div>
                <strong>{INVOICE_TYPE[i.type]}</strong> <span className="mono muted" style={{ fontSize: 12 }}>{i.number}</span>
                <div style={{ fontSize: 13 }}>
                  {formatCents(i.totalCents)} ·{" "}
                  {i.status === "paid" ? <span className="badge green">Betaald</span> : i.status === "open" && i.outstandingCents > 0 ? <span className="badge yellow">Open, vóór {formatDate(i.dueDate)}</span> : <span className="badge">{i.status === "credited" ? "Gecrediteerd" : "—"}</span>}
                </div>
              </div>
              <div className="row">
                <button className="btn small" onClick={() => setInvoice(i.id)}>Bekijken</button>
                {payment.onlinePayment && i.status === "open" && i.outstandingCents > 0 && i.type !== "credit" && (
                  <button className="btn small primary" disabled={pay.isPending} onClick={() => pay.mutate(i.id)}>Betalen</button>
                )}
              </div>
              {!payment.onlinePayment && i.status === "open" && i.outstandingCents > 0 && i.type !== "credit" && (
                <TransferInfo amountCents={i.outstandingCents} reference={i.paymentReference} iban={payment.iban} name={payment.companyName} />
              )}
            </div>
          ))}
        </>
      )}
      {invoice && <InvoiceModal id={invoice} onClose={() => setInvoice(null)} />}
      {moving && <RescheduleModal a={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

function InvoiceModal({ id, onClose }: { id: string; onClose: () => void }) {
  const inv = useQuery({ queryKey: ["portal-invoice", id], queryFn: () => api.get<InvoiceDocData>(`/public/portal/invoices/${id}`) });
  return (
    <Modal title="Factuur" onClose={onClose} wide>
      {inv.data ? <InvoiceDocument d={inv.data} /> : <ErrorBox error={inv.error} />}
      <div className="modal-actions"><button className="btn" onClick={onClose}>Sluiten</button></div>
    </Modal>
  );
}

function RescheduleModal({ a, onClose }: { a: PortalProject["appointments"][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const options = useQuery({
    queryKey: ["portal-options", a.id],
    queryFn: () => api.get<{ date: string; startMinute: number; technicianId: string; arrival: string | null; days: number }[]>(`/public/portal/appointments/${a.id}/options`),
  });
  const [choice, setChoice] = useState<string>("");
  const save = useMutation({
    mutationFn: () => {
      const [date, start, technicianId] = choice.split("|");
      return api.post(`/public/portal/appointments/${a.id}/reschedule`, { date, startMinute: Number(start), technicianId });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["portal"] });
      onClose();
    },
  });
  return (
    <Modal title={`${TYPE[a.type]} verzetten`} onClose={onClose}>
      <p>Nu gepland: <strong>{longDate(a.date)}, {a.arrival ?? WINDOW[a.timeWindow]}</strong>. Kies een ander moment bij {a.partnerName}. U ontvangt een bevestiging per e-mail.</p>
      <ErrorBox error={options.error ?? save.error} />
      {options.isLoading ? <Loading /> : !options.data?.length ? (
        <p className="muted">Er zijn op dit moment geen andere momenten beschikbaar. Neem contact met ons op.</p>
      ) : (
        <Field label="Nieuw moment">
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Kies een moment…</option>
            {options.data.map((o) => (
              <option key={`${o.date}|${o.startMinute}|${o.technicianId}`} value={`${o.date}|${o.startMinute}|${o.technicianId}`}>
                {longDate(o.date)}, {o.arrival}{o.days > 1 ? ` (${o.days} dagen)` : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" disabled={!choice || save.isPending} onClick={() => save.mutate()}>Verzetten</button>
      </div>
    </Modal>
  );
}

/** Overschrijvingsgegevens (zolang online betalen niet aanstaat, B79). */
export function TransferInfo({ amountCents, reference, iban, name }: { amountCents: number; reference: string; iban: string | null; name: string }) {
  return (
    <div className="transfer-info">
      Maak <strong>{formatCents(amountCents)}</strong> over naar <strong className="mono">{iban ?? "—"}</strong> t.n.v. {name}, met betalingskenmerk <strong className="mono">{reference}</strong>.
    </div>
  );
}
