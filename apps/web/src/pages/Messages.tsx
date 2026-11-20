import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, PageHead, StatusPill } from "../components/ui";

interface FixedMessage {
  key: string;
  label: string;
  when: string;
  subject: string;
  body: string;
  defaultSubject: string;
  defaultBody: string;
  isActive: boolean;
  isDefault: boolean;
}
interface StatusMessage {
  journeyStatusId: string;
  statusKey: string;
  name: string;
  phase: string;
  color: string;
  statusActive: boolean;
  template: { subject: string; body: string; isActive: boolean } | null;
}
interface MessageOverview {
  fixed: FixedMessage[];
  groups: { key: string; label: string; productGroup: { id: string; name: string }; salesChannel: { id: string; name: string } | null; statuses: StatusMessage[] }[];
  placeholders: Record<string, string>;
}
type Editing =
  | { kind: "fixed"; item: FixedMessage }
  | { kind: "status"; item: StatusMessage; groupName: string };

/** Statussen uit de standaard-klantreis waarbij de klant al via een ander bericht wordt geïnformeerd. */
const COVERED_ELSEWHERE: Record<string, string> = {
  order_getekend: "Klant krijgt al de bevestiging van de offerte",
  schouw_ingepland: "Klant krijgt al 'Schouw ingepland' en de aanbetalingsfactuur",
  meerwerk_akkoord: "Klant krijgt al de meerwerk-offerte",
  installatie_ingepland: "Klant krijgt al 'Installatie ingepland'",
  eindfactuur_open: "Klant krijgt al de eindfactuur",
};

const OnOff = ({ on }: { on: boolean }) => (on ? <span className="badge green">Aan</span> : <span className="badge">Uit</span>);

export function MessagesPage() {
  const { can } = useAuth();
  const overview = useQuery({ queryKey: ["message-templates"], queryFn: () => api.get<MessageOverview>("/message-templates") });
  const [groupId, setGroupId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  if (overview.isLoading) return <Loading />;
  if (!overview.data) return <ErrorBox error={overview.error} />;
  const { fixed, groups, placeholders } = overview.data;
  const current = groups.find((g) => g.key === groupId) ?? groups[0];
  const manage = can("journeys.manage");

  return (
    <>
      <PageHead
        title="Klantberichten"
        sub="E-mails die automatisch naar de klant gaan. Pas de tekst aan, zet berichten aan of uit, en bekijk vooraf hoe de e-mail eruitziet."
      />

      <div className="card flush">
        <div style={{ padding: "16px 20px 8px" }}>
          <h2 style={{ margin: 0 }}>Afspraken</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Gaan naar de klant bij het inplannen, verzetten of annuleren van een schouw of installatie, en de dag ervoor.</p>
        </div>
        <table>
          <thead><tr><th>Bericht</th><th>Wanneer</th><th>Onderwerp</th><th>Verstuurd</th></tr></thead>
          <tbody>
            {fixed.map((f) => (
              <tr key={f.key} className="clickable" onClick={() => setEditing({ kind: "fixed", item: f })}>
                <td><strong>{f.label}</strong>{!f.isDefault && <span className="badge" style={{ marginLeft: 6 }}>Aangepast</span>}</td>
                <td className="muted" style={{ fontSize: 13 }}>{f.when}</td>
                <td>{f.subject}</td>
                <td><OnOff on={f.isActive} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {current && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 0" }}>
            <h2 style={{ margin: 0 }}>Per status in de klantreis</h2>
            <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>Gaat naar de klant zodra een project deze status bereikt, ook bij een automatische statuswissel.</p>
            <div className="tabs" style={{ marginBottom: 0 }}>
              {groups.map((g) => (
                <button key={g.key} className={g.key === current.key ? "active" : ""} onClick={() => setGroupId(g.key)}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <table>
            <thead><tr><th>Fase</th><th>Status</th><th>Bericht aan klant</th><th>Verstuurd</th></tr></thead>
            <tbody>
              {current.statuses.map((s) => (
                <tr
                  key={s.journeyStatusId}
                  className={manage || s.template ? "clickable" : ""}
                  style={{ opacity: s.statusActive ? 1 : 0.5 }}
                  onClick={() => (manage || s.template) && setEditing({ kind: "status", item: s, groupName: current.label })}
                >
                  <td className="muted">{s.phase}</td>
                  <td><StatusPill status={s} /></td>
                  <td>
                    {s.template ? s.template.subject : <span className="muted">Geen bericht{manage && " — klik om er een te maken"}</span>}
                    {COVERED_ELSEWHERE[s.statusKey] && <div className="muted" style={{ fontSize: 12 }}>{COVERED_ELSEWHERE[s.statusKey]}</div>}
                  </td>
                  <td>{s.template ? <OnOff on={s.template.isActive} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        Offertes, facturen, herinneringen en aanmaningen hebben hun eigen vaste e-mails. Alle verstuurde e-mails staan op de klantkaart.
      </p>

      {editing && <MessageForm editing={editing} placeholders={placeholders} readOnly={!manage} onClose={() => setEditing(null)} />}
    </>
  );
}

function MessageForm({ editing, placeholders, readOnly, onClose }: { editing: Editing; placeholders: Record<string, string>; readOnly: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const start =
    editing.kind === "fixed"
      ? { subject: editing.item.subject, body: editing.item.body, isActive: editing.item.isActive }
      : editing.item.template ?? { subject: `Update over uw {productgroep}`, body: "Beste {naam},\n\n", isActive: true };
  const [form, setForm] = useState(start);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string; unknownPlaceholders: string[] } | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Voorvertoning: kort na het typen opnieuw opmaken.
  useEffect(() => {
    if (!form.subject.trim() || !form.body.trim()) return;
    const t = setTimeout(() => {
      api.post<typeof preview>("/message-templates/preview", { subject: form.subject, body: form.body }).then(setPreview).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [form.subject, form.body]);

  const url = editing.kind === "fixed" ? `/message-templates/fixed/${editing.item.key}` : `/message-templates/status/${editing.item.journeyStatusId}`;
  const save = useMutation({
    mutationFn: () => api.put(url, form),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["message-templates"] });
      onClose();
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ to: string; status: string; error: string | null }>("/message-templates/test", { subject: form.subject, body: form.body }),
    onSuccess: (r) => setTestResult(r.status === "sent" ? `Testmail verstuurd naar ${r.to}` : r.status === "not_sent" ? `Vastgelegd voor ${r.to}, maar niet verstuurd (geen e-mailkoppeling)` : `Versturen mislukt: ${r.error}`),
  });

  const insert = (key: string) => {
    const el = bodyRef.current;
    const token = `{${key}}`;
    if (!el) return setForm({ ...form, body: form.body + token });
    const { selectionStart: a, selectionEnd: b } = el;
    const body = form.body.slice(0, a) + token + form.body.slice(b);
    setForm({ ...form, body });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };

  const title = editing.kind === "fixed" ? `Bericht: ${editing.item.label}` : `Bericht bij status "${editing.item.name}" (${editing.groupName})`;
  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error ?? test.error} />
        {editing.kind === "fixed" && <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Wanneer: {editing.item.when}</p>}
        <div className="grid-2">
          <div>
            <label className="row" style={{ marginBottom: 12, fontWeight: 500 }}>
              <input type="checkbox" checked={form.isActive} disabled={readOnly} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              Bericht versturen
            </label>
            <Field label="Onderwerp">
              <input value={form.subject} disabled={readOnly} maxLength={200} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
            </Field>
            <Field label="Tekst (lege regel = nieuwe alinea)">
              <textarea ref={bodyRef} rows={14} value={form.body} disabled={readOnly} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
            </Field>
            {!readOnly && (
              <div style={{ fontSize: 13 }}>
                <div className="muted" style={{ marginBottom: 4 }}>Invulvelden (klik om in te voegen):</div>
                {Object.entries(placeholders).map(([k, label]) => (
                  <button type="button" key={k} className="chip" title={label} onClick={() => insert(k)}>{`{${k}}`}</button>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>Voorbeeld (met voorbeeldgegevens)</div>
            {preview?.unknownPlaceholders.length ? (
              <div className="alert warning">Onbekend invulveld: {preview.unknownPlaceholders.map((u) => `{${u}}`).join(", ")}</div>
            ) : null}
            <div style={{ fontSize: 14, marginBottom: 6 }}><strong>Onderwerp:</strong> {preview?.subject ?? "…"}</div>
            <iframe className="mail-preview" title="Voorbeeld e-mail" sandbox="" srcDoc={preview?.html ?? ""} />
          </div>
        </div>
        {testResult && <div className="alert info" style={{ marginTop: 12 }}>{testResult}</div>}
        <div className="modal-actions">
          {!readOnly && editing.kind === "fixed" && (
            <button type="button" className="btn" style={{ marginRight: "auto" }} onClick={() => setForm({ ...form, subject: editing.item.defaultSubject, body: editing.item.defaultBody })}>
              Standaardtekst terugzetten
            </button>
          )}
          {!readOnly && <button type="button" className="btn" disabled={test.isPending} onClick={() => { setTestResult(null); test.mutate(); }}>Testmail naar mij</button>}
          <button type="button" className="btn" onClick={onClose}>{readOnly ? "Sluiten" : "Annuleren"}</button>
          {!readOnly && <button className="btn primary" disabled={save.isPending}>Opslaan</button>}
        </div>
      </form>
    </Modal>
  );
}
