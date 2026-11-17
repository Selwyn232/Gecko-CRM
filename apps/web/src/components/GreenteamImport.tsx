import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Product, type ProductType } from "../api";
import { formatCents, formatDate, formatQty, PRODUCT_TYPES } from "../format";
import { useProductGroups } from "../hooks";
import { suggestProductCode } from "../productCode";
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
type Choice = { action: "product"; productId: string } | { action: "new"; code: string; name: string; type: ProductType } | { action: "skip" };
interface GroupProduct {
  id: string;
  code: string;
  name: string;
  type: ProductType;
  salesPriceCents: number | null;
}
interface LineSuggestions {
  lines: { description: string; quantity: number; choice: Choice; reason: "alias" | "name" | "new" | "condition" }[];
  products: GroupProduct[];
}
interface Preview {
  parsed: {
    externalNumber: string;
    quoteDate: string | null;
    validUntil: string | null;
    signedDate: string | null;
    customer: ParsedCustomer;
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
  lineSuggestions: LineSuggestions | null;
}
interface ImportResult {
  customerId: string;
  quoteId: string;
  quoteNumber: string;
  projectId: string;
  createdCustomer: boolean;
  createdAdvisor: boolean;
  createdProducts: string[];
  warnings: string[];
}

type FormState = { [K in "firstName" | "lastName" | "email" | "phone" | "street" | "houseNumber" | "houseNumberAddition" | "postalCode" | "city"]: string };

const REASON: Record<string, string> = { alias: "eerder gekoppeld", name: "zelfde naam", new: "nieuw product", condition: "voorwaarde, geen product" };

/** Zelfde regel als de server: catalogusprijzen blijven, het restant van de afgesproken prijs staat op de eerste regel. */
function allocate(lines: { quantity: number; catalogUnitCents: number | null }[], subtotalCents: number) {
  if (!lines.length) return [];
  const others = lines.slice(1).map((l) => l.catalogUnitCents ?? 0);
  const othersTotal = lines.slice(1).reduce((s, l, i) => s + Math.round(others[i]! * l.quantity), 0);
  const mainQty = lines[0]!.quantity || 1;
  const rest = subtotalCents - othersTotal;
  if (rest < 0) return [Math.round(subtotalCents / mainQty), ...others.map(() => 0)];
  return [Math.round(rest / mainQty), ...others];
}

/** Getekende Greenteam-offertes (PDF) inlezen als order aan Gecko: klant, producten, offerte en project. */
export function GreenteamImportModal({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
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
        <strong>Sleep de getekende offerte-PDF('s) hierheen</strong> of klik om te kiezen
        <div className="muted" style={{ fontSize: 12 }}>
          De gegevens worden automatisch uitgelezen. Na controle wordt de klant aangemaakt (of gekoppeld), de offerte als geaccepteerde order vastgelegd met de producten per regel, en het project gestart.
        </div>
        <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }} onChange={(e) => add(e.target.files)} />
      </label>
      {files.map((f, i) => <ImportItem key={`${f.name}-${i}`} file={f} />)}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Sluiten</button>
      </div>
    </Modal>
  );
}

function ImportItem({ file }: { file: File }) {
  const qc = useQueryClient();
  const groups = useProductGroups();
  const allProducts = useQuery({ queryKey: ["products", "all-codes"], queryFn: () => api.get<Product[]>("/products") });
  const [data, setData] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [groupId, setGroupId] = useState("");
  const [suggestions, setSuggestions] = useState<LineSuggestions | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  /** Codes die de gebruiker zelf heeft aangepast (anders volgt de code het voorstel). */
  const [codeTouched, setCodeTouched] = useState<Record<number, boolean>>({});

  const applySuggestions = (s: LineSuggestions | null) => {
    setSuggestions(s);
    setChoices(s ? s.lines.map((l) => l.choice) : []);
    setCodeTouched({});
  };

  const preview = useMutation({
    meta: { toast: false },
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
      applySuggestions(p.lineSuggestions);
    },
  });
  const changeGroup = useMutation({
    meta: { toast: false },
    mutationFn: (id: string) => api.post<LineSuggestions>("/imports/greenteam/lines", { productGroupId: id, lines: preview.data!.parsed.lines }),
    onSuccess: applySuggestions,
  });

  // Codevoorstel voor nieuwe producten: uniek t.o.v. bestaande producten én de andere nieuwe regels.
  const group = groups.data?.find((g) => g.id === groupId) ?? null;
  const effectiveChoices: Choice[] = useMemo(() => {
    const taken = (allProducts.data ?? []).map((p) => p.code);
    return choices.map((ch, i) => {
      if (ch.action !== "new" || codeTouched[i]) {
        if (ch.action === "new") taken.push(ch.code);
        return ch;
      }
      const code = suggestProductCode({ name: ch.name, type: ch.type, group, supplierName: null }, taken)?.code ?? "";
      taken.push(code);
      return { ...ch, code };
    });
  }, [choices, codeTouched, allProducts.data, group]);

  const run = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("/imports/greenteam", {
        filename: file.name,
        dataBase64: data,
        existingCustomerId: mode === "existing" ? preview.data?.existingCustomer?.id : null,
        productGroupId: groupId,
        customer: form,
        lines: effectiveChoices,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["customers"] });
      await qc.invalidateQueries({ queryKey: ["external-quotes"] });
      await qc.invalidateQueries({ queryKey: ["products"] });
    },
  });

  useEffect(() => {
    preview.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const p = preview.data;

  const productById = (id: string) => suggestions?.products.find((x) => x.id === id);
  const mappedIdx = effectiveChoices.map((c, i) => (c.action === "skip" ? -1 : i)).filter((i) => i >= 0);
  const prices = p?.parsed.subtotalCents != null
    ? allocate(
        mappedIdx.map((i) => {
          const ch = effectiveChoices[i]!;
          return { quantity: p.parsed.lines[i]!.quantity, catalogUnitCents: ch.action === "product" ? (productById(ch.productId)?.salesPriceCents ?? null) : null };
        }),
        p.parsed.subtotalCents,
      )
    : [];
  const priceOf = (i: number) => {
    const k = mappedIdx.indexOf(i);
    return k < 0 ? null : prices[k]!;
  };
  const missingCode = effectiveChoices.some((c) => c.action === "new" && !c.code.trim());
  const ready = !!p && !!form && !!groupId && !!suggestions && mappedIdx.length > 0 && !missingCode && !p.alreadyImported && !run.isSuccess && !run.isPending;

  const setChoice = (i: number, ch: Choice) => setChoices(choices.map((c, j) => (j === i ? ch : c)));
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
      <ErrorBox error={preview.error ?? run.error ?? changeGroup.error} />
      {p && form && (
        p.alreadyImported ? (
          <div className="alert warning" style={{ marginTop: 8 }}>
            Deze offerte is al ingelezen. <Link to={`/klanten/${p.alreadyImported.customerId}`}>Naar de klantkaart</Link>
          </div>
        ) : run.isSuccess ? (
          <div className="alert success" style={{ marginTop: 8 }}>
            Ingelezen als order: {run.data.createdCustomer ? "klant aangemaakt" : "gekoppeld aan bestaande klant"}, offerte{" "}
            <Link to={`/offertes/${run.data.quoteId}`}>{run.data.quoteNumber}</Link> geaccepteerd, <Link to={`/projecten/${run.data.projectId}`}>project</Link> gestart
            {run.data.createdProducts.length > 0 && `, ${run.data.createdProducts.length} nieuwe product(en): ${run.data.createdProducts.join(", ")}`}
            {run.data.createdAdvisor && `, adviseur ${p.advisor?.name} toegevoegd bij Greenteam`}. <Link to={`/klanten/${run.data.customerId}`}>Naar de klantkaart</Link>
            {run.data.warnings.map((w) => <div key={w} style={{ color: "var(--text)" }}>Let op: {w}</div>)}
          </div>
        ) : (
          <>
            {p.parsed.warnings.length > 0 && (
              <div className="alert warning" style={{ marginTop: 8 }}>
                Controleer: {p.parsed.warnings.join(" · ")}
              </div>
            )}
            <h3 style={{ margin: "12px 0 4px" }}>Klant</h3>
            {p.existingCustomer && (
              <div className="row" style={{ margin: "4px 0 8px", gap: 16 }}>
                <label className="checkbox" style={{ margin: 0 }}>
                  <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> Bestaande klant{" "}
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
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
              {field("street", "Straat")}
              {field("houseNumber", "Huisnummer")}
              {field("houseNumberAddition", "Toevoeging")}
            </div>
            <div className="grid-2">
              {field("postalCode", "Postcode")}
              {field("city", "Plaats")}
            </div>

            <h3 style={{ margin: "12px 0 4px" }}>Order</h3>
            <div className="grid-2">
              <Field label="Productgroep">
                <select
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    if (e.target.value) changeGroup.mutate(e.target.value);
                    else applySuggestions(null);
                  }}
                >
                  <option value="">Kies…</option>
                  {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </Field>
              <Field label="Adviseur (Greenteam)">
                <input value={p.advisor ? `${p.advisor.name}${p.advisor.isNew ? " — wordt toegevoegd" : ""}` : "—"} disabled />
              </Field>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              Aanbetaling: {p.parsed.depositMethod ?? "—"} · {p.parsed.signedDate ? `ondertekend op ${formatDate(p.parsed.signedDate)}` : "getekend bij Greenteam"} · afgesproken prijs {formatCents(p.parsed.subtotalCents)} excl. btw
            </div>

            {suggestions && (
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Regel op de offerte</th><th className="num">Aantal</th><th>Product in Gecko</th><th className="num">Prijs p/st</th></tr></thead>
                <tbody>
                  {p.parsed.lines.map((l, i) => {
                    const ch = effectiveChoices[i] ?? { action: "skip" };
                    const value = ch.action === "product" ? ch.productId : ch.action;
                    const price = priceOf(i);
                    return (
                      <Fragment key={i}>
                        <tr>
                          <td>
                            {l.description}
                            <div className="muted" style={{ fontSize: 11 }}>{REASON[suggestions.lines[i]?.reason ?? "new"]}</div>
                          </td>
                          <td className="num">{formatQty(l.quantity)}</td>
                          <td>
                            <select
                              value={value}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "skip") setChoice(i, { action: "skip" });
                                else if (v === "new") setChoice(i, { action: "new", code: "", name: l.description, type: suggestions.lines[i]?.choice.action === "new" ? (suggestions.lines[i]!.choice as { type: ProductType }).type : "component" });
                                else setChoice(i, { action: "product", productId: v });
                              }}
                            >
                              <option value="new">+ Nieuw product</option>
                              {suggestions.products.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}
                              <option value="skip">Overslaan (geen product)</option>
                            </select>
                          </td>
                          <td className="num">{price == null ? <span className="muted">—</span> : formatCents(price)}</td>
                        </tr>
                        {ch.action === "new" && (
                          <tr>
                            <td colSpan={4} style={{ background: "var(--bg)" }}>
                              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <select value={ch.type} onChange={(e) => setChoice(i, { ...ch, type: e.target.value as ProductType })}>
                                  {(["component", "labor", "service", "package", "extra_work"] as const).map((t) => <option key={t} value={t}>{PRODUCT_TYPES[t]}</option>)}
                                </select>
                                <input value={ch.name} onChange={(e) => setChoice(i, { ...ch, name: e.target.value })} style={{ flex: 2, minWidth: 200 }} aria-label="Productnaam" />
                                <input
                                  className="mono"
                                  value={ch.code}
                                  onChange={(e) => {
                                    setCodeTouched({ ...codeTouched, [i]: true });
                                    setChoice(i, { ...ch, code: e.target.value });
                                  }}
                                  style={{ flex: 1, minWidth: 180 }}
                                  aria-label="Productcode"
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
            {suggestions && (
              <p className="muted" style={{ fontSize: 12 }}>
                De afgesproken prijs is leidend: regels met een verkoopprijs voor Greenteam houden die, de eerste regel krijgt het restant. Gekozen koppelingen worden onthouden voor de volgende offerte. Nieuwe producten krijgen btw hoog; vul inkoopprijs of partnertarief later aan bij Producten.
              </p>
            )}
            {ready && (
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <button className="btn primary" onClick={() => run.mutate()}>
                  {mode === "existing" ? `Inlezen als order bij ${p.existingCustomer?.displayNumber}` : "Inlezen als order en klant aanmaken"}
                </button>
              </div>
            )}
          </>
        )
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
  depositMethod: string | null;
  lines: { description: string; quantity: number }[];
  subtotalCents: number | null;
  vatCents: number | null;
  totalCents: number | null;
  productGroupName: string | null;
  advisorName: string | null;
  quoteId: string | null;
  quoteNumber: string | null;
  projectId: string | null;
  projectNumber: string | null;
  filename: string;
  hasFile: boolean;
  createdAt: string;
  createdByName: string | null;
}

/** Op de klantkaart: ingelezen Greenteam-offertes (origineel) met de order die eruit is gemaakt. */
export function CustomerExternalQuotes({ customerId }: { customerId: string }) {
  const list = useQuery({ queryKey: ["external-quotes", customerId], queryFn: () => api.get<ExternalQuote[]>(`/customers/${customerId}/external-quotes`) });
  const [open, setOpen] = useState<string | null>(null);
  if (!list.data?.length) return null;
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}>
        <h2 style={{ margin: 0 }}>Offertes Greenteam</h2>
        <div className="muted" style={{ fontSize: 13 }}>Getekende offertes van Greenteam (origineel als PDF) en de order die er in Gecko van is gemaakt.</div>
      </div>
      <table>
        <thead><tr><th>Greenteam</th><th>Datum</th><th>Productgroep</th><th>Adviseur</th><th>Order in Gecko</th><th className="num">Totaal incl. btw</th><th></th></tr></thead>
        <tbody>
          {list.data.map((q) => (
            <Fragment key={q.id}>
              <tr className="clickable" onClick={() => setOpen(open === q.id ? null : q.id)}>
                <td className="mono">#{q.externalNumber}</td>
                <td>{formatDate(q.quoteDate)}</td>
                <td>{q.productGroupName ?? <span className="muted">—</span>}</td>
                <td>{q.advisorName ?? <span className="muted">—</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {q.quoteId ? <Link to={`/offertes/${q.quoteId}`}>{q.quoteNumber}</Link> : <span className="muted">—</span>}
                  {q.projectId && <> · <Link to={`/projecten/${q.projectId}`}>{q.projectNumber}</Link></>}
                </td>
                <td className="num">{formatCents(q.totalCents)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {q.hasFile ? <a className="btn small" href={`/api/external-quotes/${q.id}/pdf`} target="_blank" rel="noreferrer">PDF</a> : <span className="muted">verwijderd</span>}
                </td>
              </tr>
              {open === q.id && (
                <tr>
                  <td colSpan={7} style={{ background: "var(--bg)" }}>
                    <div className="muted" style={{ fontSize: 13 }}>
                      Aanbetaling: {q.depositMethod ?? "—"} · {q.signedDate ? `ondertekend ${formatDate(q.signedDate)}` : "getekend bij Greenteam"} · Ingelezen {formatDate(q.createdAt)}
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
