import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { formatDateTime } from "../format";

interface Notification { id: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string }

/** Belletje met meldingen (ververst elke minuut). */
export function NotificationBell({ placement = "up" }: { placement?: "up" | "down" } = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const data = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ unread: number; items: Notification[] }>("/notifications"), refetchInterval: 60_000 });
  const read = useMutation({ meta: { toast: false }, mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  const unread = data.data?.unread ?? 0;
  return (
    <div className="bell">
      <button className="btn small" onClick={() => setOpen(!open)} aria-label={`Meldingen (${unread} ongelezen)`}>
        🔔 {unread > 0 && <span className="badge red">{unread}</span>}
      </button>
      {open && (
        <div className={`bell-panel ${placement === "down" ? "down" : ""}`} role="dialog" aria-label="Meldingen">
          <div className="row" style={{ justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
            <strong>Meldingen</strong>
            {unread > 0 && <button className="btn small" onClick={() => read.mutate("all")}>Alles gelezen</button>}
          </div>
          {!data.data?.items.length ? <div className="muted" style={{ padding: 12 }}>Geen meldingen.</div> : (
            data.data.items.map((n) => (
              <button
                key={n.id}
                className={`bell-item ${n.readAt ? "" : "unread"}`}
                onClick={() => {
                  if (!n.readAt) read.mutate(n.id);
                  setOpen(false);
                  if (n.href) navigate(n.href);
                }}
              >
                <strong>{n.title}</strong>
                {n.body && <div style={{ fontSize: 12 }}>{n.body}</div>}
                <div className="muted" style={{ fontSize: 11 }}>{formatDateTime(n.createdAt)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
