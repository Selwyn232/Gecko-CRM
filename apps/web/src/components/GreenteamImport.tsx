import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { formatCents, formatDate, formatQty } from "../format";
import { useProductGroups } from "../hooks";
import { toBase64 } from "./PhotoUpload";
import { ErrorBox, Field, Modal } from "./ui";

interface ParsedCustomer {
  fullName: string;
  firstName: string | null;
  lastName: string;
  street: string | null;
  houseNumber: string | null;
  houseNumberAddition: string | null;
  postalCode: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
}
interface Preview {
  parsed: {
    externalNumber: string;
    quoteDate: string | null;
    validUntil: string | null;
    signedDate: string | null;
    customer: ParsedCustomer;
    installer: { name: string | null };
    advisor: { name: string | null; email: string | null };
    depositMethod: string | null;
    lines: { description: string; quantity: number }[];
    subtotalCents: number | null;
    vatCents: number | null;
    totalCents: number | null;
    warnings: string[];
  };
  alreadyImported: { id: string; customerId: string } | null;
  existingCustomer: { id: string; name: string; displayNumber: string; matchedOn: string } | null;
  advisor: { id: string | null; name: string; isNew: boolean } | null;
  productGroupId: string | null;
}
interface ImportResult {
  customerId: string;
  createdCustomer: boolean;
  createdAdvisor: boolean;
}

type FormState = { [K in "firstName" | "lastName" | "email" | "phone" | "street" | "houseNumber" | "houseNumberAddition" | "postalCode" | "city"]: string };

/** Greenteam-offertes (PDF) inlezen: uitlezen, controleren, klant aanmaken of koppelen, PDF op de klantkaart. */
export function GreenteamImportModal({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [runAll, setRunAll] = useState(0);
  const [dragging, setDragging] = useState(false);
  const add = (list: FileList | null) => setFiles((f) => [...f, ...Array.from(list ?? []).filter((x) => x.type === "application/pdf" || x.name.toLowerCase().endsWith(".pdf"))]);
  return (
    <Modal title="Greenteam-offerte inlezen" onClose={onClose} wide>
      <label
        className={`dropzone ${dragging ? "active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <strong>Sleep de offerte-PDF('s) hierheen</strong> of klik om te kiezen
        <div className="muted" style={{ fontSize: 12 }}>
          De gegevens worden automatisch uitgelezen. Controleer ze en klik op "Inlezen": de klant wordt aangemaakt (of gekoppeld als die al bestaat) en de offerte komt op de klantkaart.
        </div>
        <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }} onChange={(e) => add(e.target.files)} />
      </label>
      {files.length > 1 && (
        <div className="row" style={{ justifyContent: "flex-end", margin: "8px 0" }}>
          <button className="btn primary" onClick={() => setRunAll((n) => n + 1)}>Alles inlezen zonder waarschuwingen</button>
        </div>
      )}
      {files.map((f, i) => <ImportItem key={`${f.name}-${i}`} file={f} runAll={runAll} />)}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Sluiten</button>
      </div>
    </Modal>
  );
}

function ImportItem({ file, runAll }: { file: File; runAll: number }) {
  const qc = useQueryClient();
  const groups = useProductGroups();
  const [data, setData] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [groupId, setGroupId] = useState("");
  const [showLines, setShowLines] = useState(false);

  const preview = useMutation({
    mutationFn: async () => {
      const b64 = await toBase64(file);
      setData(b64);
      return api.post<Preview>("/imports/greenteam/preview", { filename: file.name, dataBase64: b64 });
    },
    onSuccess: (p) => {
      const c = p.parsed.customer;
      setForm({
        firstName: c.firstName ?? "",
        lastName: c.lastName,
        email: c.email ?? "",
        phone: c.phone ?? "",
        street: c.street ?? "",
        houseNumber: c.houseNumber ?? "",
        houseNumberAddition: c.houseNumberAddition ?? "",
        postalCode: c.postalCode ?? "",
        city: c.city ?? "",
      });
      setMode(p.existingCustomer ? "existing" : "new");
      setGroupId(p.productGroupId ?? "");
    },
  });
  const run = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("/imports/greenteam", {
        filename: file.name,
        dataBase64: data,
        existingCustomerId: mode === "existing" ? preview.data?.existingCustomer?.id : null,
        productGroupId: groupId || null,
        customer: form,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["customers"] });
      await qc.invalidateQueries({ queryKey: ["external-quotes"] });
    },
  });

  useEffect(() => {
    preview.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const p = preview.data;
  const ready = !!p && !!form && !p.alreadyImported && !run.isSuccess && !run.isPending;
  useEffect(() => {
    if (runAll > 0 && ready && p && !p.parsed.warnings.length) run.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAll]);

  const set = (k: keyof FormState, v: string) => form && setForm({ ...form, [k]: v });
  const field = (k: keyof FormState, label: string) => (
    <Field label={label}>
      <input value={form?.[k] ?? ""} onChange={(e) => set(k, e.target.value)} disabled={mode === "existing" && !["street", "houseNumber", "houseNumberAddition", "postalCode", "city"].includes(k)} />
    </Field>
  );

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{file.name}</strong>
        {p && <span className="muted">Offerte #{p.parsed.externalNumber} · {formatDate(p.parsed.quoteDate)} · {formatCents(p.parsed.totalCents)} incl. btw</span>}
      </div>
      {preview.isPending && <p className="muted">Uitlezen…</p>}
      <ErrorBox error={preview.error ?? run.error} />
      {p && form && (
        <>
          {p.alreadyImported ? (
            <div className="alert warning" style={{ marginTop: 8 }}>
              Deze offerte is al ingelezen. <Link to={`/klanten/${p.alreadyImported.customerId}`}>Naar de klantkaart</Link>
            </div>
          ) : run.isSuccess ? (
            <div className="alert success" style={{ marginTop: 8 }}>
              Ingelezen{run.data.createdCustomer ? ", klant aangemaakt" : ", gekoppeld aan bestaande klant"}
              {run.data.createdAdvisor ? `, adviseur ${p.advisor?.name} toegevoegd bij Greenteam` : ""}. <Link to={`/klanten/${run.data.customerId}`}>Naar de klantkaart</Link>
            </div>
          ) : (
            <>
              {p.parsed.warnings.length > 0 && (
                <div className="alert warning" style={{ marginTop: 8 }}>
                  Controleer: {p.parsed.warnings.join(" · ")}
                </div>
              )}
              {p.existingCustomer && (
                <div className="row" style={{ margin: "8px 0", gap: 16 }}>
                  <label className="checkbox" style={{ margin: 0 }}>
                    <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Koppelen aan bestaande klant{" "}
                    <Link to={`/klanten/${p.existingCustomer.id}`} target="_blank">{p.existingCustomer.displayNumber} {p.existingCustomer.name}</Link>
                    <span className="muted"> (herkend op {p.existingCustomer.matchedOn})</span>
                  </label>
                  <label className="checkbox" style={{ margin: 0 }}>
                    <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> Toch nieuwe klant
                  </label>
                </div>
              )}
              <div className="grid-2">
                {field("firstName", "Voornaam / voorletters")}
                {field("lastName", "Achternaam")}
                {field("email", "E-mail")}
                {field("phone", "Telefoon")}
              </div>
              <div className="grid-3" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
                {field("street", "Straat")}
                {field("houseNumber", "Huisnummer")}
                {field("houseNumberAddition", "Toevoeging")}
              </div>
              <div className="grid-2">
                {field("postalCode", "Postcode")}
                {field("city", "Plaats")}
              </div>
              <div className="grid-2">
                <Field label="Productgroep">
                  <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    <option value="">Onbekend</option>
                    {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </Field>
                <Field label="Adviseur (Greenteam)">
                  <input value={p.advisor ? `${p.advisor.name}${p.advisor.isNew ? " — wordt toegevoegd" : ""}` : "—"} disabled />
                </Field>
              </div>
            </>
          )}
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Uitvoerder: {p.parsed.installer.name ?? "—"} · Aanbetaling: {p.parsed.depositMethod ?? "—"} · Geldig tot {formatDate(p.parsed.validUntil)} ·{" "}
            {p.parsed.signedDate ? `ondertekend op ${formatDate(p.parsed.signedDate)}` : "niet ondertekend"} ·{" "}
            <button className="link" onClick={() => setShowLines(!showLines)}>{p.parsed.lines.length} regels {showLines ? "verbergen" : "tonen"}</button>
          </div>
          {showLines && <QuoteLines lines={p.parsed.lines} subtotal={p.parsed.subtotalCents} vat={p.parsed.vatCents} total={p.parsed.totalCents} />}
          {ready && (
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn primary" onClick={() => run.mutate()}>
                {mode === "existing" ? `Inlezen bij ${p.existingCustomer?.displayNumber}` : "Inlezen en klant aanmaken"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function QuoteLines({ lines, subtotal, vat, total }: { lines: { description: string; quantity: number }[]; subtotal: number | null; vat: number | null; total: number | null }) {
  return (
    <table style={{ marginTop: 6 }}>
      <thead><tr><th>Omschrijving</th><th className="num">Aantal</th></tr></thead>
      <tbody>
        {lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{formatQty(l.quantity)}</td></tr>)}
        <tr><td className="muted">Subtotaal / btw / totaal</td><td className="num" style={{ whiteSpace: "nowrap" }}>{formatCents(subtotal)} / {formatCents(vat)} / <strong>{formatCents(total)}</strong></td></tr>
      </tbody>
    </table>
  );
}

interface ExternalQuote {
  id: string;
  externalNumber: string;
  quoteDate: string | null;
  validUntil: string | null;
  signedDate: string | null;
  installerName: string | null;
  depositMethod: string | null;
  lines: { description: string; quantity: number }[];
  subtotalCents: number | null;
  vatCents: number | null;
  totalCents: number | null;
  productGroupName: string | null;
  advisorName: string | null;
  filename: string;
  hasFile: boolean;
  createdAt: string;
  createdByName: string | null;
}

/** Op de klantkaart: ingelezen Greenteam-offertes met de PDF. */
export function CustomerExternalQuotes({ customerId }: { customerId: string }) {
  const list = useQuery({ queryKey: ["external-quotes", customerId], queryFn: () => api.get<ExternalQuote[]>(`/customers/${customerId}/external-quotes`) });
  const [open, setOpen] = useState<string | null>(null);
  if (!list.data?.length) return null;
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}>
        <h2 style={{ margin: 0 }}>Offertes Greenteam</h2>
        <div className="muted" style={{ fontSize: 13 }}>Ingelezen uit de PDF van Greenteam; de PDF is het origineel.</div>
      </div>
      <table>
        <thead><tr><th>Offerte</th><th>Datum</th><th>Productgroep</th><th>Adviseur</th><th>Status</th><th className="num">Totaal incl. btw</th><th></th></tr></thead>
        <tbody>
          {list.data.map((q) => (
            <Fragment key={q.id}>
              <tr className="clickable" onClick={() => setOpen(open === q.id ? null : q.id)}>
                <td className="mono">#{q.externalNumber}</td>
                <td>{formatDate(q.quoteDate)}</td>
                <td>{q.productGroupName ?? <span className="muted">—</span>}</td>
                <td>{q.advisorName ?? <span className="muted">—</span>}</td>
                <td>{q.signedDate ? <span className="badge green">Ondertekend {formatDate(q.signedDate)}</span> : <span className="badge">Niet ondertekend</span>}</td>
                <td className="num">{formatCents(q.totalCents)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {q.hasFile ? <a className="btn small" href={`/api/external-quotes/${q.id}/pdf`} target="_blank" rel="noreferrer">PDF</a> : <span className="muted">verwijderd</span>}
                </td>
              </tr>
              {open === q.id && (
                <tr>
                  <td colSpan={7} style={{ background: "var(--bg)" }}>
                    <div className="muted" style={{ fontSize: 13 }}>
                      Uitvoerder: {q.installerName ?? "—"} · Aanbetaling: {q.depositMethod ?? "—"} · Geldig tot {formatDate(q.validUntil)} · Ingelezen {formatDate(q.createdAt)}
                      {q.createdByName && ` door ${q.createdByName}`}
                    </div>
                    <QuoteLines lines={q.lines} subtotal={q.subtotalCents} vat={q.vatCents} total={q.totalCents} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
