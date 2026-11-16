import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type CustomerDetail, type CustomerSummary, type Paged } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { customerName, formatAddress, formatDate } from "../format";
import { useChannels } from "../hooks";

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CustomersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search);
  const list = useQuery({
    queryKey: ["customers", q],
    queryFn: () => api.get<Paged<CustomerSummary>>(`/customers?limit=100${q ? `&search=${encodeURIComponent(q)}` : ""}`),
  });

  return (
    <>
      <PageHead
        title="Klanten"
        sub="Zoek op naam, e-mail, telefoon, postcode, adres of klantnummer."
        actions={
          <>
            <a className="btn" href="/api/exports/klanten.csv">Exporteren (CSV)</a>
            {can("customers.manage") && <button className="btn primary" onClick={() => setCreating(true)}>Nieuwe klant</button>}
          </>
        }
      />
      <div className="row" style={{ marginBottom: 12 }}>
        <input placeholder="Zoeken…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 320 }} autoFocus />
        {list.data && <span className="muted">{list.data.total} klant(en)</span>}
      </div>
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.items.length ? (
          <div className="empty">{q ? "Geen klanten gevonden." : "Nog geen klanten."}</div>
        ) : (
          <table>
            <thead><tr><th>Nr.</th><th>Naam</th><th>Adres</th><th>Contact</th><th className="num">Projecten</th><th>Sinds</th></tr></thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/klanten/${c.id}`)}>
                  <td className="mono">{c.displayNumber}</td>
                  <td><strong>{customerName(c)}</strong></td>
                  <td>{c.properties[0] ? formatAddress(c.properties[0]) : <span className="muted">—</span>}{c.properties.length > 1 && <span className="muted"> +{c.properties.length - 1}</span>}</td>
                  <td>{c.email && <div>{c.email}</div>}{c.phone && <div className="muted">{c.phone}</div>}</td>
                  <td className="num">{c.projectCount}</td>
                  <td className="muted">{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CustomerForm onClose={() => setCreating(false)} onSaved={(c) => navigate(`/klanten/${c.id}`)} />}
    </>
  );
}

const emptyAddress = { street: "", houseNumber: "", houseNumberAddition: "", postalCode: "", city: "" };

export function AddressFields({ value, onChange }: { value: typeof emptyAddress; onChange: (v: typeof emptyAddress) => void }) {
  const set = (k: keyof typeof emptyAddress, v: string) => onChange({ ...value, [k]: v });
  return (
    <>
      <div className="grid-2">
        <Field label="Postcode"><input value={value.postalCode} onChange={(e) => set("postalCode", e.target.value)} placeholder="1234 AB" required /></Field>
        <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <Field label="Huisnummer"><input value={value.houseNumber} onChange={(e) => set("houseNumber", e.target.value)} required style={{ width: "100%" }} /></Field>
          <Field label="Toevoeging"><input value={value.houseNumberAddition} onChange={(e) => set("houseNumberAddition", e.target.value)} style={{ width: "100%" }} /></Field>
        </div>
      </div>
      <div className="grid-2">
        <Field label="Straat"><input value={value.street} onChange={(e) => set("street", e.target.value)} required /></Field>
        <Field label="Plaats"><input value={value.city} onChange={(e) => set("city", e.target.value)} required /></Field>
      </div>
    </>
  );
}

export function CustomerForm({ customer, onClose, onSaved }: { customer?: CustomerDetail; onClose: () => void; onSaved?: (c: CustomerDetail) => void }) {
  const qc = useQueryClient();
  const channels = useChannels();
  const [form, setForm] = useState({
    firstName: customer?.firstName ?? "",
    lastName: customer?.lastName ?? "",
    email: customer?.email ?? "",
    phone: customer?.phone ?? "",
    salesChannelId: customer?.salesChannelId ?? "",
    notes: customer?.notes ?? "",
  });
  const [address, setAddress] = useState(emptyAddress);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, firstName: form.firstName || null, email: form.email || null, phone: form.phone || null, salesChannelId: form.salesChannelId || null, notes: form.notes || null };
      return customer
        ? api.patch<CustomerDetail>(`/customers/${customer.id}`, body)
        : api.post<CustomerDetail>("/customers", { ...body, property: { ...address, houseNumberAddition: address.houseNumberAddition || null } });
    },
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["customers"] });
      await qc.invalidateQueries({ queryKey: ["customer", c.id] });
      onSaved?.(c);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Modal title={customer ? "Klantgegevens wijzigen" : "Nieuwe klant"} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={save.error} />
        <div className="grid-2">
          <Field label="Voornaam"><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} autoFocus /></Field>
          <Field label="Achternaam"><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required /></Field>
          <Field label="E-mail"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Telefoon"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="06 12345678" /></Field>
        </div>
        <Field label="Binnengekomen via">
          <select value={form.salesChannelId} onChange={(e) => setForm({ ...form, salesChannelId: e.target.value })}>
            <option value="">Onbekend</option>
            {channels.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {!customer && (
          <>
            <div className="field" style={{ marginTop: 4 }}>Adres woning</div>
            <AddressFields value={address} onChange={setAddress} />
          </>
        )}
        <Field label="Notities"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={save.isPending}>Opslaan</button>
        </div>
      </form>
    </Modal>
  );
}
