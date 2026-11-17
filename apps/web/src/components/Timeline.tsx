import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { formatDateTime } from "../format";
import { ErrorBox } from "./ui";

interface Entry { at: string; kind: string; title: string; detail?: string | null; by?: string | null; projectNumber?: string | null; href?: string | null }

const ICON: Record<string, string> = { note: "✎", call: "☎", email: "✉", status: "➜", appointment: "📅", quote: "📄", invoice: "€", payment: "✓" };
const FILTERS: Record<string, string[] | null> = { Alles: null, Notities: ["note", "call"], "E-mails": ["email"], Project: ["status", "appointment"], Financieel: ["quote", "invoice", "payment"] };

/** Klanttijdlijn met notitie- en belnotitieveld. */
export function CustomerTimeline({ customerId, projects }: { customerId: string; projects: { id: string; displayNumber: string }[] }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const tl = useQuery({ queryKey: ["timeline", customerId], queryFn: () => api.get<Entry[]>(`/customers/${customerId}/timeline`) });
  const [filter, setFilter] = useState("Alles");
  const [kind, setKind] = useState<"note" | "call">("note");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");
  const add = useMutation({
    meta: { toast: "Notitie toegevoegd" },
    mutationFn: () => api.post(`/customers/${customerId}/notes`, { kind, body, projectId: projectId || null }),
    onSuccess: async () => {
      setBody("");
      await qc.invalidateQueries({ queryKey: ["timeline", customerId] });
    },
  });
  const kinds = FILTERS[filter];
  const items = (tl.data ?? []).filter((e) => !kinds || kinds.includes(e.kind));
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 0" }}>
        <h2 style={{ margin: 0 }}>Tijdlijn</h2>
        {can("customers.manage") && (
          <form className="note-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (body.trim()) add.mutate(); }}>
            <ErrorBox error={add.error} />
            <div className="row" style={{ marginBottom: 6 }}>
              <button type="button" className={`btn small ${kind === "note" ? "primary" : ""}`} onClick={() => setKind("note")}>✎ Notitie</button>
              <button type="button" className={`btn small ${kind === "call" ? "primary" : ""}`} onClick={() => setKind("call")}>☎ Telefoongesprek</button>
              {projects.length > 0 && (
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ marginLeft: "auto" }}>
                  <option value="">Geen project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.displayNumber}</option>)}
                </select>
              )}
            </div>
            <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={kind === "call" ? "Waar ging het gesprek over?" : "Interne notitie (niet zichtbaar voor de klant)"} style={{ width: "100%" }} />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
              <button className="btn primary small" disabled={!body.trim() || add.isPending}>Opslaan</button>
            </div>
          </form>
        )}
        <div className="tabs" style={{ marginBottom: 0 }}>
          {Object.keys(FILTERS).map((f) => <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
      </div>
      {!items.length ? <div className="empty">Nog niets.</div> : (
        <ul className="timeline">
          {items.map((e, i) => (
            <li key={i} className={`tl-${e.kind}`}>
              <span className="tl-icon" aria-hidden>{ICON[e.kind] ?? "•"}</span>
              <div>
                <div>
                  {e.href ? <Link to={e.href}>{e.title}</Link> : <strong>{e.title}</strong>}
                  {e.projectNumber && <span className="badge" style={{ marginLeft: 6 }}>{e.projectNumber}</span>}
                </div>
                {e.detail && <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{e.detail}</div>}
                <div className="muted" style={{ fontSize: 12 }}>{formatDateTime(e.at)}{e.by && ` · ${e.by}`}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
