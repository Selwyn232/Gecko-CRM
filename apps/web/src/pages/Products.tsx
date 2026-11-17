import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Product, type ProductType } from "../api";
import { useAuth } from "../auth";
import { ActiveBadge, ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { PRODUCT_TYPES } from "../format";
import { nameById, useOrganizations, useProductGroups, useVatCodes } from "../hooks";
import { suggestProductCode } from "../productCode";

export function ProductsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const groups = useProductGroups();
  const [groupId, setGroupId] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams();
  if (groupId) params.set("productGroupId", groupId);
  if (type) params.set("type", type);
  if (search) params.set("search", search);
  const products = useQuery({ queryKey: ["products", params.toString()], queryFn: () => api.get<Product[]>(`/products?${params}`) });

  return (
    <>
      <PageHead
        title="Producten"
        sub="Pakketten, componenten, arbeid en meerwerk — met stuklijsten en prijzen per kanaal."
        actions={can("catalog.manage") && <button className="btn primary" onClick={() => setCreating(true)}>Nieuw product</button>}
      />
      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Zoek op code of naam" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 240 }} />
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Alle productgroepen</option>
          {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Alle typen</option>
          {Object.entries(PRODUCT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="card flush">
        {products.isLoading ? <Loading /> : !products.data?.length ? (
          <div className="empty">Nog geen producten{can("catalog.manage") ? " — maak er een aan met ‘Nieuw product’." : "."}</div>
        ) : (
          <table>
            <thead><tr><th>Code</th><th>Naam</th><th>Productgroep</th><th>Type</th><th>Btw</th><th>Status</th></tr></thead>
            <tbody>
              {products.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/producten/${p.id}`)}>
                  <td className="mono">{p.code}</td>
                  <td>{p.name}</td>
                  <td>{nameById(groups.data, p.productGroupId)}</td>
                  <td>{PRODUCT_TYPES[p.type]}</td>
                  <td>{p.vatCode}</td>
                  <td><ActiveBadge active={p.isActive} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <ProductForm onClose={() => setCreating(false)} onSaved={(p) => navigate(`/producten/${p.id}`)} />}
    </>
  );
}

export function ProductForm({ product, onClose, onSaved }: { product?: Product; onClose: () => void; onSaved?: (p: Product) => void }) {
  const qc = useQueryClient();
  const groups = useProductGroups();
  const vat = useVatCodes();
  const orgs = useOrganizations();
  const [form, setForm] = useState({
    code: product?.code ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    productGroupId: product?.productGroupId ?? "",
    type: (product?.type ?? "package") as ProductType,
    unit: product?.unit ?? "stuk",
    vatCode: product?.vatCode ?? "hoog",
    defaultSupplierOrganizationId: product?.defaultSupplierOrganizationId ?? "",
    isActive: product?.isActive ?? true,
  });
  const set = (k: keyof typeof form, v: unknown) => setForm({ ...form, [k]: v });

  // Nieuw product: codevoorstel uit de ingevulde velden, tot de gebruiker de code zelf aanpast.
  const isNew = !product;
  const [codeTouched, setCodeTouched] = useState(false);
  const all = useQuery({ queryKey: ["products", "all-codes"], queryFn: () => api.get<Product[]>("/products"), enabled: isNew });
  const group = groups.data?.find((g) => g.id === form.productGroupId) ?? null;
  const supplier = orgs.data?.find((o) => o.id === form.defaultSupplierOrganizationId) ?? null;
  const suggestion = isNew
    ? suggestProductCode({ name: form.name, type: form.type, group, supplierName: supplier?.name ?? null }, (all.data ?? []).map((p) => p.code))
    : null;
  const code = isNew && !codeTouched ? (suggestion?.code ?? "") : form.code;

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, code, description: form.description || null, defaultSupplierOrganizationId: form.defaultSupplierOrganizationId || null };
      return product ? api.patch<Product>(`/products/${product.id}`, body) : api.post<Product>("/products", body);
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["product", p.id] });
      onSaved?.(p);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Modal title={product ? "Product wijzigen" : "Nieuw product"} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={save.error} />
        <div className="grid-2">
          {!isNew && <Field label="Productcode"><input value={form.code} onChange={(e) => set("code", e.target.value)} required className="mono" /></Field>}
          <Field label="Type">
            <select value={form.type} onChange={(e) => set("type", e.target.value)}>
              {Object.entries(PRODUCT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Naam"><input value={form.name} onChange={(e) => set("name", e.target.value)} required /></Field>
        <Field label="Omschrijving"><textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} /></Field>
        <div className="grid-2">
          <Field label="Productgroep">
            <select value={form.productGroupId} onChange={(e) => set("productGroupId", e.target.value)} required>
              <option value="">Kies…</option>
              {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field label="Btw-code">
            <select value={form.vatCode} onChange={(e) => set("vatCode", e.target.value)}>
              {vat.data?.map((v) => <option key={v.code} value={v.code}>{v.name} ({(v.currentRateBasisPoints ?? 0) / 100}%)</option>)}
            </select>
          </Field>
          <Field label="Eenheid"><input value={form.unit} onChange={(e) => set("unit", e.target.value)} /></Field>
          <Field label="Standaardleverancier">
            <select value={form.defaultSupplierOrganizationId} onChange={(e) => set("defaultSupplierOrganizationId", e.target.value)}>
              <option value="">Geen</option>
              {orgs.data?.filter((o) => o.type === "supplier").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
        </div>
        {isNew && (
          <Field label="Productcode">
            <input
              value={code}
              onChange={(e) => {
                setCodeTouched(true);
                set("code", e.target.value);
              }}
              required
              className="mono"
              placeholder="Vul naam en productgroep in voor een voorstel"
            />
            {suggestion && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {codeTouched && code !== suggestion.code ? (
                  <>
                    Voorstel: <span className="mono">{suggestion.code}</span>{" "}
                    <button type="button" className="btn small" onClick={() => setCodeTouched(false)}>Voorstel gebruiken</button>
                  </>
                ) : (
                  <>
                    Opbouw:{" "}
                    {suggestion.explain.map((e, i) => (
                      <span key={i}>
                        {i > 0 && " · "}
                        <span className="mono">{e.part}</span> = {e.from}
                      </span>
                    ))}
                    . Pas gerust aan; na gebruik op een offerte ligt de code vast.
                  </>
                )}
              </div>
            )}
          </Field>
        )}
        <label className="checkbox"><input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} /> Actief</label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={save.isPending}>Opslaan</button>
        </div>
      </form>
    </Modal>
  );
}
