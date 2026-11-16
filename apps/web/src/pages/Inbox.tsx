import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type CustomerSummary, type Paged } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Loading, PageHead } from "../components/ui";
import { formatDateTime } from "../format";

interface InboundEmail {
  id: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string;
  text: string;
  attachmentCount: string | null;
  customerId: string | null;
  customerName: string | null;
  projectId: string | null;
  projectNumber: string | null;
  status: "new" | "handled";
  receivedAt: string;
}

/** Inbox: binnengekomen e-mails van klanten, koppelen aan de klant en beantwoorden vanuit het CRM. */
export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<"new" | "handled">("new");
  const list = useQuery({ queryKey: ["inbox", status], queryFn: () => api.get<InboundEmail[]>(`/inbox?status=${status}`), refetchInterval: 60_000 });
  const selectedId = params.get("id") ?? list.data?.[0]?.id ?? null;
  const all = useQuery({ queryKey: ["inbox", "all-for-detail"], queryFn: () => api.get<InboundEmail[]>("/inbox"), enabled: !!params.get("id") });
  const selected = list.data?.find((m) => m.id === selectedId) ?? all.data?.find((m) => m.id === selectedId) ?? null;
  return (
    <>
      <PageHead title="Inbox" sub="E-mails van klanten aan het serviceadres. Gekoppeld aan de klant op afzender (en project op P-nummer in het onderwerp)." />
      <div className="tabs">
        <button className={status === "new" ? "active" : ""} onClick={() => setStatus("new")}>Nieuw {status === "new" && list.data?.length ? <span className="badge red">{list.data.length}</span> : null}</button>
        <button className={status === "handled" ? "active" : ""} onClick={() => setStatus("handled")}>Afgehandeld</button>
      </div>
      {list.isLoading ? <Loading /> : (
        <div className="inbox">
          <div className="card flush inbox-list">
            {!list.data?.length ? <div className="empty">{status === "new" ? "Geen nieuwe e-mails." : "Nog niets afgehandeld."}</div> : list.data.map((m) => (
              <button key={m.id} className={`inbox-item ${m.id === selectedId ? "active" : ""}`} onClick={() => setParams({ id: m.id })}>
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.fromName ?? m.fromAddress}</strong>
                  <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{formatDateTime(m.receivedAt)}</span>
                </div>
                <div style={{ fontSize: 13 }}>{m.subject}</div>
                <div className="muted" style={{ fontSize: 12 }}>{m.customerName ?? "Niet gekoppeld"}{m.projectNumber && ` · ${m.projectNumber}`}</div>
              </button>
            ))}
          </div>
          <div>{selected ? <MessageView key={selected.id} m={selected} /> : <div className="card empty">Kies een bericht.</div>}</div>
        </div>
      )}
    </>
  );
}

function MessageView({ m }: { m: InboundEmail }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [reply, setReply] = useState("");
  const [linking, setLinking] = useState(false);
  const [q, setQ] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["inbox"] });
  const send = useMutation({ mutationFn: () => api.post<{ status: string; error: string | null }>(`/inbox/${m.id}/reply`, { text: reply }), onSuccess: async () => { setReply(""); await refresh(); } });
  const update = useMutation({ mutationFn: (body: { customerId?: string | null; status?: "new" | "handled" }) => api.patch(`/inbox/${m.id}`, body), onSuccess: async () => { setLinking(false); await refresh(); } });
  const found = useQuery({ queryKey: ["customer-search", q], queryFn: () => api.get<Paged<CustomerSummary>>(`/customers?search=${encodeURIComponent(q)}&limit=8&offset=0`), enabled: linking && q.length >= 2 });
  const manage = can("customers.manage");
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>{m.subject}</h2>
          <div className="muted" style={{ fontSize: 13 }}>Van {m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress} · {formatDateTime(m.receivedAt)}{m.attachmentCount && ` · ${m.attachmentCount} bijlage(n) (niet opgeslagen)`}</div>
        </div>
        {manage && (m.status === "new"
          ? <button className="btn" onClick={() => update.mutate({ status: "handled" })}>Afgehandeld</button>
          : <button className="btn" onClick={() => update.mutate({ status: "new" })}>Terug naar nieuw</button>)}
      </div>
      <ErrorBox error={send.error ?? update.error} />
      <div className="row" style={{ margin: "10px 0" }}>
        {m.customerId ? <Link className="badge green" to={`/klanten/${m.customerId}`}>Klant: {m.customerName}</Link> : <span className="badge yellow">Geen klant gekoppeld</span>}
        {m.projectId && <Link className="badge" to={`/projecten/${m.projectId}`}>{m.projectNumber}</Link>}
        {manage && <button className="btn small" onClick={() => setLinking(!linking)}>{m.customerId ? "Andere klant" : "Koppelen aan klant"}</button>}
      </div>
      {linking && (
        <div style={{ marginBottom: 12 }}>
          <input autoFocus placeholder="Zoek klant op naam, e-mail, postcode…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
          {found.data?.items.map((c) => (
            <button key={c.id} className="bell-item" onClick={() => update.mutate({ customerId: c.id })}>
              <strong>{[c.firstName, c.lastName].filter(Boolean).join(" ")}</strong> <span className="muted">{c.displayNumber} · {c.email ?? ""}</span>
            </button>
          ))}
        </div>
      )}
      <div style={{ whiteSpace: "pre-wrap", padding: "12px 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>{m.text || <span className="muted">(geen tekst)</span>}</div>
      {manage && (
        <div style={{ marginTop: 12 }}>
          <textarea rows={6} style={{ width: "100%" }} placeholder={`Antwoord aan ${m.fromName ?? m.fromAddress}…`} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>Gaat per e-mail naar {m.fromAddress}, met het oorspronkelijke bericht eronder; wordt vastgelegd op de klantkaart.</span>
            <button className="btn primary" disabled={!reply.trim() || send.isPending} onClick={() => send.mutate()}>Versturen en afhandelen</button>
          </div>
          {send.data && send.data.status !== "sent" && <div className="alert warning" style={{ marginTop: 8 }}>Vastgelegd, maar niet verstuurd{send.data.error ? `: ${send.data.error}` : " (geen e-mailkoppeling)"}.</div>}
        </div>
      )}
    </div>
  );
}
