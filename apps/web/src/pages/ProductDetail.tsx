import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type BomLine, type Cost, type PriceVersion, type Product } from "../api";
import { useAuth } from "../auth";
import { ActiveBadge, ErrorBox, Field, Loading, Modal } from "../components/ui";
import { formatCents, formatDate, parseEuro, PRODUCT_TYPES, todayIso } from "../format";
import { nameById, useChannels, useOrganizations, useProductGroups } from "../hooks";
import { ProductForm } from "./Products";

type ProductDetail = Product & { bom: BomLine[] };

export function ProductDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const groups = useProductGroups();
  const [editing, setEditing] = useState(false);
  const product = useQuery({ queryKey: ["product", id], queryFn: () => api.get<ProductDetail>(`/products/${id}`) });

  if (product.isLoading) return <Loading />;
  if (!product.data) return <ErrorBox error={product.error ?? "Niet gevonden"} />;
  const p = product.data;

  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/producten">← Producten</Link></div>
      <div className="page-head">
        <div>
          <h1>{p.name}</h1>
          <p className="row">
            <span className="mono">{p.code}</span>
            <span className="badge">{PRODUCT_TYPES[p.type]}</span>
            <span className="badge">{nameById(groups.data, p.productGroupId)}</span>
            <ActiveBadge active={p.isActive} />
          </p>
        </div>
        {can("catalog.manage") && <button className="btn" onClick={() => setEditing(true)}>Wijzigen</button>}
      </div>
      {p.description && <p>{p.description}</p>}

      <PricesCard product={p} />
      <BomCard product={p} />
      {can("purchase_prices.read") && p.bom.length > 0 && <CostCard product={p} />}
      {editing && <ProductForm product={p} onClose={() => setEditing(false)} />}
    </>
  );
}

// ------------------------------------------------------------ Prijzen

const KINDS = {
  sales: { label: "Verkoopprijzen", path: "sales-prices", scopeLabel: "Verkoopkanaal", read: "catalog.read", manage: "sales_prices.manage" },
  purchase: { label: "Inkoopprijzen", path: "purchase-prices", scopeLabel: "Leverancier", read: "purchase_prices.read", manage: "purchase_prices.manage" },
  partner: { label: "Partnertarieven", path: "partner-rates", scopeLabel: "Installatiepartner", read: "purchase_prices.read", manage: "purchase_prices.manage" },
} as const;
type Kind = keyof typeof KINDS;

function PricesCard({ product }: { product: ProductDetail }) {
  const { can } = useAuth();
  const visible = (Object.keys(KINDS) as Kind[]).filter((k) => can(KINDS[k].read));
  const [kind, setKind] = useState<Kind>("sales");
  return (
    <div className="card">
      <div className="tabs">
        {visible.map((k) => (
          <button key={k} className={k === kind ? "active" : ""} onClick={() => setKind(k)}>{KINDS[k].label}</button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Bedragen exclusief btw. Een prijswijziging is een nieuwe versie met een ingangsdatum; ingegane prijzen blijven bewaard en zijn niet te wijzigen.
      </p>
      <PriceTable key={kind} product={product} kind={kind} />
    </div>
  );
}

function PriceTable({ product, kind }: { product: ProductDetail; kind: Kind }) {
  const cfg = KINDS[kind];
  const { can } = useAuth();
  const qc = useQueryClient();
  const channels = useChannels();
  const orgs = useOrganizations(kind !== "sales");
  const [adding, setAdding] = useState(false);
  const versions = useQuery({
    queryKey: ["prices", kind, product.id],
    queryFn: () => api.get<PriceVersion[]>(`/products/${product.id}/${cfg.path}`),
  });

  const scopes: { id: string; name: string }[] =
    kind === "sales"
      ? (channels.data ?? []).filter((c) => c.productGroupIds.includes(product.productGroupId))
      : (orgs.data ?? []).filter((o) => o.type === (kind === "purchase" ? "supplier" : "installation_partner"));

  const today = todayIso();
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/${cfg.path}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prices", kind, product.id] }),
  });

  /** Per scope: welke versie geldt nu? */
  const currentIds = new Set(
    scopes
      .map((s) => versions.data?.filter((v) => v.scopeId === s.id && v.validFrom <= today).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]?.id)
      .filter(Boolean),
  );

  return (
    <>
      <ErrorBox error={remove.error} />
      {versions.isLoading ? <Loading /> : !versions.data?.length ? (
        <div className="empty">Nog geen {cfg.label.toLowerCase()}.</div>
      ) : (
        <table>
          <thead><tr><th>{cfg.scopeLabel}</th><th className="num">Prijs</th><th>Ingangsdatum</th><th>Status</th><th /></tr></thead>
          <tbody>
            {versions.data.map((v) => (
              <tr key={v.id}>
                <td>{nameById(scopes, v.scopeId)}</td>
                <td className="num">{formatCents(v.priceCents)}</td>
                <td>{formatDate(v.validFrom)}</td>
                <td>
                  {v.validFrom > today ? <span className="badge yellow">Toekomstig</span> : currentIds.has(v.id) ? <span className="badge green">Geldend</span> : <span className="badge">Historisch</span>}
                </td>
                <td className="num">
                  {can(cfg.manage) && v.validFrom > today && (
                    <button className="btn small danger" onClick={() => remove.mutate(v.id)}>Verwijderen</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can(cfg.manage) && (
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setAdding(true)} disabled={!scopes.length}>Nieuwe prijs</button>
          {!scopes.length && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
              {kind === "sales" ? "Geen verkoopkanaal verkoopt deze productgroep." : `Voeg eerst een ${cfg.scopeLabel.toLowerCase()} toe bij Organisaties.`}
            </span>
          )}
        </div>
      )}
      {adding && (
        <PriceForm
          title={`Nieuwe ${cfg.label.toLowerCase().replace(/en$/, "")}`}
          scopeLabel={cfg.scopeLabel}
          scopes={scopes}
          onClose={() => setAdding(false)}
          onSubmit={async (body) => {
            await api.post(`/products/${product.id}/${cfg.path}`, body);
            await qc.invalidateQueries({ queryKey: ["prices", kind, product.id] });
            await qc.invalidateQueries({ queryKey: ["cost", product.id] });
          }}
        />
      )}
    </>
  );
}

function PriceForm(props: {
  title: string;
  scopeLabel: string;
  scopes: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (body: { scopeId: string; priceCents: number; validFrom: string }) => Promise<void>;
}) {
  const [scopeId, setScopeId] = useState(props.scopes[0]?.id ?? "");
  const [price, setPrice] = useState("");
  const [validFrom, setValidFrom] = useState(todayIso());
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = parseEuro(price);
    if (cents === null) return setError("Ongeldig bedrag");
    try {
      await props.onSubmit({ scopeId, priceCents: cents, validFrom });
      props.onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label={props.scopeLabel}>
          <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            {props.scopes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Prijs excl. btw (€)"><input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1.234,56" required autoFocus /></Field>
          <Field label="Ingangsdatum"><input type="date" min={todayIso()} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} required /></Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>Annuleren</button>
          <button className="btn primary">Opslaan</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ Stuklijst

function BomCard({ product }: { product: ProductDetail }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Stuklijst</h2>
        {can("catalog.manage") && <button className="btn small" onClick={() => setEditing(true)}>Bewerken</button>}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Waaruit dit product intern bestaat. De klant ziet alleen het pakket; de stuklijst is de basis voor de kostprijs.</p>
      {!product.bom.length ? <div className="empty">Geen stuklijst.</div> : (
        <table>
          <thead><tr><th>Code</th><th>Naam</th><th>Type</th><th className="num">Aantal</th></tr></thead>
          <tbody>
            {product.bom.map((b) => (
              <tr key={b.id}>
                <td className="mono"><Link to={`/producten/${b.componentProductId}`}>{b.code}</Link></td>
                <td>{b.name}</td>
                <td>{PRODUCT_TYPES[b.type]}</td>
                <td className="num">{Number(b.quantity).toLocaleString("nl-NL")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <BomEditor product={product} onClose={() => setEditing(false)} />}
    </div>
  );
}

function BomEditor({ product, onClose }: { product: ProductDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const all = useQuery({ queryKey: ["products", ""], queryFn: () => api.get<Product[]>("/products") });
  const [items, setItems] = useState(product.bom.map((b) => ({ componentProductId: b.componentProductId, quantity: String(Number(b.quantity)) })));
  const save = useMutation({
    mutationFn: () =>
      api.put(`/products/${product.id}/bom`, {
        items: items.filter((i) => i.componentProductId).map((i) => ({ componentProductId: i.componentProductId, quantity: Number(i.quantity.replace(",", ".")) })),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["product", product.id] });
      await qc.invalidateQueries({ queryKey: ["cost", product.id] });
      onClose();
    },
  });
  const options = (all.data ?? []).filter((p) => p.id !== product.id);

  return (
    <Modal title="Stuklijst bewerken" onClose={onClose}>
      <ErrorBox error={save.error} />
      {items.map((item, i) => (
        <div key={i} className="row" style={{ marginBottom: 8, flexWrap: "nowrap" }}>
          <select style={{ flex: 1, minWidth: 0 }} value={item.componentProductId} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, componentProductId: e.target.value } : x)))}>
            <option value="">Kies component…</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
          </select>
          <input style={{ width: 80 }} value={item.quantity} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} aria-label="Aantal" />
          <button className="btn small danger" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Verwijderen">✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => setItems([...items, { componentProductId: "", quantity: "1" }])}>+ Regel</button>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ Kostprijs

function CostCard({ product }: { product: ProductDetail }) {
  const orgs = useOrganizations();
  const partners = (orgs.data ?? []).filter((o) => o.type === "installation_partner");
  const [partnerId, setPartnerId] = useState("");
  const [date, setDate] = useState(todayIso());
  const params = new URLSearchParams({ date });
  if (partnerId) params.set("partnerOrganizationId", partnerId);
  const cost = useQuery({ queryKey: ["cost", product.id, params.toString()], queryFn: () => api.get<Cost>(`/products/${product.id}/cost?${params}`) });

  return (
    <div className="card">
      <h2>Kostprijs</h2>
      <p className="muted" style={{ fontSize: 13 }}>Inkoop bij de standaardleverancier + tarief van de gekozen installatiepartner voor arbeid, op de gekozen datum. Basis voor de voorcalculatie.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          <option value="">Geen installatiepartner</option>
          {partners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {cost.data && (
        <>
          {!cost.data.complete && <div className="alert warning">Ontbrekende prijzen: {cost.data.missingPrices.join(", ")}. Deze tellen niet mee in het totaal.</div>}
          <table>
            <thead><tr><th>Component</th><th className="num">Aantal</th><th className="num">Per stuk</th><th className="num">Totaal</th></tr></thead>
            <tbody>
              {cost.data.lines.map((l) => (
                <tr key={l.productId}>
                  <td><span className="mono">{l.code}</span> <span className="muted">{l.name}</span></td>
                  <td className="num">{Number(l.quantity).toLocaleString("nl-NL")}</td>
                  <td className="num">{formatCents(l.unitCostCents)}</td>
                  <td className="num">{formatCents(l.totalCents)}</td>
                </tr>
              ))}
              <tr><td colSpan={3}><strong>Totaal kostprijs</strong></td><td className="num"><strong>{formatCents(cost.data.totalCents)}</strong></td></tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
