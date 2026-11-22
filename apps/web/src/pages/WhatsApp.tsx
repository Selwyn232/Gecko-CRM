import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { Loading, PageHead } from "../components/ui";
import { formatDateTime } from "../format";

interface ConversationRow {
  customerId: string | null;
  waId: string;
  name: string;
  lastAt: string;
  lastBody: string;
  lastDirection: "in" | "out";
  unread: number;
  waitingSince: string | null;
  specialist: string | null;
}
interface Status {
  sending: boolean;
  receiving: boolean;
  webhookUrl: string;
  language: string;
  templates: { name: string; header: string | null; text: string; example: string[] }[];
  last7Days: { out: number; failed: number };
}

const waited = (iso: string) => {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} uur` : `${Math.round(h / 24)} dagen`;
};

/** Gesprekken (B83): wie wacht op antwoord staat bovenaan, oudste eerst. Specialist ziet alleen eigen klanten. */
export function WhatsAppPage() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["whatsapp-conversations"], queryFn: () => api.get<ConversationRow[]>("/whatsapp/conversations"), refetchInterval: 15_000 });
  const status = useQuery({ queryKey: ["whatsapp-status"], queryFn: () => api.get<Status>("/whatsapp/status") });
  if (list.isLoading) return <Loading />;
  const rows = list.data ?? [];
  return (
    <>
      <PageHead title="WhatsApp" sub="Gesprekken met klanten. Wie wacht op antwoord staat bovenaan, de langst wachtende eerst." />
      {status.data && (!status.data.sending || !status.data.receiving) && <Setup s={status.data} />}
      <div className="card flush">
        {!rows.length ? (
          <div className="empty">Nog geen WhatsApp-gesprekken.</div>
        ) : (
          <table>
            <thead><tr><th>Klant</th><th>Laatste bericht</th><th>Wacht</th><th>Specialist</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.customerId ?? r.waId} className={r.customerId ? "clickable" : ""} onClick={() => r.customerId && navigate(`/klanten/${r.customerId}#whatsapp`)}>
                  <td>
                    <span className="with-avatar">
                      <Avatar name={r.name} size={28} />
                      <span>
                        <strong>{r.name}</strong>
                        {r.unread > 0 && <span className="badge red" style={{ marginLeft: 6 }}>{r.unread} nieuw</span>}
                        {!r.customerId && <div className="muted" style={{ fontSize: 12 }}>Onbekend nummer: koppel aan een klant door het nummer op de klantkaart te zetten</div>}
                      </span>
                    </span>
                  </td>
                  <td style={{ maxWidth: 420 }}>
                    <div className="muted" style={{ fontSize: 12 }}>{r.lastDirection === "in" ? "Klant" : "Gecko"} · {formatDateTime(r.lastAt)}</div>
                    <div className="ellipsis">{r.lastBody}</div>
                  </td>
                  <td>{r.waitingSince ? <span className={`badge ${Date.now() - new Date(r.waitingSince).getTime() > 86_400_000 ? "red" : "yellow"}`}>{waited(r.waitingSince)}</span> : <span className="muted">—</span>}</td>
                  <td>{r.specialist ?? <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Setup({ s }: { s: Status }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>WhatsApp koppelen</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {s.sending ? "Versturen werkt." : "Versturen staat nog uit: berichten worden alleen vastgelegd."} {s.receiving ? "Ontvangen werkt." : "Ontvangen staat nog uit."} Stappen staan in de documentatie (docs/14-whatsapp.md).
      </p>
      <dl className="kv">
        <dt>Webhook-URL voor Meta</dt><dd className="mono" style={{ wordBreak: "break-all" }}>{s.webhookUrl}</dd>
        <dt>Taal sjablonen</dt><dd>{s.language}</dd>
      </dl>
      <h3>Sjablonen om aan te maken in WhatsApp Manager (categorie: Utility)</h3>
      {s.templates.map((t) => (
        <div key={t.name} className="wa-template">
          <div><strong className="mono">{t.name}</strong>{t.header === "image" && <span className="badge" style={{ marginLeft: 6 }}>kop: afbeelding</span>}</div>
          <div style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{t.text}</div>
          <div className="muted" style={{ fontSize: 12 }}>Voorbeeldwaarden: {t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join(", ")}</div>
        </div>
      ))}
    </div>
  );
}
