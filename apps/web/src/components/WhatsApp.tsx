import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { formatDateTime } from "../format";
import { ErrorBox } from "./ui";

/** WhatsApp-gesprek met de klant (B83). */
export interface WaMessage {
  id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  templateName: string | null;
  status: string;
  error: string | null;
  emailId: string | null;
  sentByName: string | null;
  createdAt: string;
}
interface Conversation {
  waId: string | null;
  enabled: boolean;
  windowOpen: boolean;
  messages: WaMessage[];
}

const STATUS: Record<string, string> = { queued: "wordt verstuurd", sent: "✓", delivered: "✓✓", read: "✓✓ gelezen", failed: "mislukt", not_sent: "niet verstuurd (WhatsApp nog niet gekoppeld)", received: "" };

export function WhatsAppPanel({ customerId }: { customerId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const conv = useQuery({
    queryKey: ["whatsapp", customerId],
    queryFn: () => api.get<Conversation>(`/customers/${customerId}/whatsapp?markRead=true`),
    refetchInterval: 15_000,
  });
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["whatsapp", customerId] });
  const send = useMutation({
    meta: { toast: false },
    mutationFn: (body: { text?: string; invite?: boolean }) => api.post<WaMessage>(`/customers/${customerId}/whatsapp`, body),
    onSuccess: async () => {
      setText("");
      await refresh();
      await qc.invalidateQueries({ queryKey: ["whatsapp-conversations"] });
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put(`/customers/${customerId}/whatsapp/enabled`, { enabled }),
    onSuccess: refresh,
  });
  const count = conv.data?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  if (!conv.data) return <div className="card"><h2>WhatsApp</h2><ErrorBox error={conv.error} /></div>;
  const c = conv.data;
  const manage = can("customers.manage");
  return (
    <div className="card" id="whatsapp">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>WhatsApp</h2>
        <span className="row" style={{ gap: 8 }}>
          {c.waId ? <span className="muted mono" style={{ fontSize: 12 }}>+{c.waId}</span> : <span className="badge">Geen mobiel nummer</span>}
          {c.waId && manage && (
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={c.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} /> Aan
            </label>
          )}
        </span>
      </div>
      <div className="wa-thread">
        {!c.messages.length && <div className="empty" style={{ padding: 16 }}>Nog geen berichten. Alles wat per e-mail naar deze klant gaat, gaat ook via WhatsApp.</div>}
        {c.messages.map((m) => (
          <div key={m.id} className={`wa-msg ${m.direction}`}>
            <div className="wa-bubble">
              {m.templateName && <div className="wa-tag">{m.emailId ? "Kopie van e-mail" : "Sjabloon"}</div>}
              {!m.templateName && m.emailId && <div className="wa-tag">Kopie van e-mail</div>}
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
              <div className="wa-meta">
                {m.direction === "out" && m.sentByName ? `${m.sentByName} · ` : ""}
                {formatDateTime(m.createdAt)}
                {m.direction === "out" && <span className={m.status === "failed" ? "wa-failed" : ""}> {STATUS[m.status] ?? m.status}</span>}
              </div>
              {m.status === "failed" && m.error && <div className="wa-failed" style={{ fontSize: 12 }}>{m.error}</div>}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <ErrorBox error={send.error ?? toggle.error} />
      {manage && c.waId && c.enabled && (
        c.windowOpen ? (
          <form
            className="wa-compose"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send.mutate({ text });
            }}
          >
            <textarea
              aria-label="Bericht"
              rows={2}
              value={text}
              placeholder="Typ een bericht…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim()) send.mutate({ text });
                }
              }}
            />
            <button className="btn primary" disabled={!text.trim() || send.isPending}>Versturen</button>
          </form>
        ) : (
          <div className="wa-closed">
            <span className="muted" style={{ fontSize: 13 }}>
              De klant heeft de afgelopen 24 uur niets gestuurd. WhatsApp staat dan alleen goedgekeurde berichten toe. Stuur een uitnodiging; zodra de klant reageert, kun je vrij typen.
            </span>
            <button className="btn" disabled={send.isPending} onClick={() => send.mutate({ invite: true })}>Uitnodiging sturen</button>
          </div>
        )
      )}
      {c.waId && !c.enabled && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>WhatsApp staat uit voor deze klant (bijvoorbeeld na STOP). Berichten gaan alleen per e-mail.</p>}
    </div>
  );
}
