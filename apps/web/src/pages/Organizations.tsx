import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Organization } from "../api";
import { useAuth } from "../auth";
import { ActiveBadge, ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { ORG_TYPES } from "../format";
import { useAdvisors, useOrganizations } from "../hooks";

export function OrganizationsPage() {
  const { can } = useAuth();
  const orgs = useOrganizations();
  const [editing, setEditing] = useState<Organization | "new" | null>(null);
  const [type, setType] = useState("");
  const list = (orgs.data ?? []).filter((o) => !type || o.type === type);

  return (
    <>
      <PageHead
        title="Organisaties"
        sub="Gecko, verkooppartners, installatiepartners en leveranciers."
        actions={can("organizations.manage") && <button className="btn primary" onClick={() => setEditing("new")}>Nieuwe organisatie</button>}
      />
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Alle soorten</option>
          {Object.entries(ORG_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="card flush">
        {orgs.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th>Naam</th><th>Soort</th><th>KvK</th><th>E-mail</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} className={can("organizations.manage") ? "clickable" : ""} onClick={() => can("organizations.manage") && setEditing(o)}>
                  <td><strong>{o.name}</strong></td>
                  <td>{ORG_TYPES[o.type]}</td>
                  <td>{o.kvkNumber ?? "—"}</td>
                  <td>{o.email ?? "—"}</td>
                  <td><ActiveBadge active={o.isActive} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <OrgForm org={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function OrgForm({ org, onClose }: { org?: Organization; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: org?.name ?? "",
    type: org?.type ?? "installation_partner",
    kvkNumber: org?.kvkNumber ?? "",
    email: org?.email ?? "",
    phone: org?.phone ?? "",
    vatNumber: org?.vatNumber ?? "",
    street: org?.street ?? "",
    houseNumber: org?.houseNumber ?? "",
    postalCode: org?.postalCode ?? "",
    city: org?.city ?? "",
    iban: org?.iban ?? "",
    selfBillingPrefix: org?.selfBillingPrefix ?? "",
    selfBillingVatMode: org?.selfBillingVatMode ?? "",
    isActive: org?.isActive ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      const empty = (v: string) => (v.trim() === "" ? null : v.trim());
      const body = {
        ...form,
        kvkNumber: empty(form.kvkNumber),
        email: empty(form.email),
        phone: empty(form.phone),
        vatNumber: empty(form.vatNumber),
        street: empty(form.street),
        houseNumber: empty(form.houseNumber),
        postalCode: empty(form.postalCode),
        city: empty(form.city),
        iban: empty(form.iban),
        selfBillingPrefix: empty(form.selfBillingPrefix.toUpperCase()),
        selfBillingVatMode: form.selfBillingVatMode === "" ? null : form.selfBillingVatMode,
      };
      if (org) {
        const { type: _t, ...rest } = body;
        return api.patch(`/organizations/${org.id}`, rest);
      }
      return api.post("/organizations", body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["organizations"] });
      onClose();
    },
  });
  return (
    <Modal title={org ? "Organisatie wijzigen" : "Nieuwe organisatie"} onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Naam"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Soort">
        <select value={form.type} disabled={!!org} onChange={(e) => setForm({ ...form, type: e.target.value as Organization["type"] })}>
          {Object.entries(ORG_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <div className="grid-2">
        <Field label="KvK-nummer"><input value={form.kvkNumber} onChange={(e) => setForm({ ...form, kvkNumber: e.target.value })} /></Field>
        <Field label="Telefoon"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
      </div>
      <Field label="E-mail"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Straat"><input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} /></Field>
        <Field label="Huisnummer"><input value={form.houseNumber} onChange={(e) => setForm({ ...form, houseNumber: e.target.value })} /></Field>
        <Field label="Postcode"><input value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} /></Field>
        <Field label="Plaats"><input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
        <Field label="Btw-nummer"><input value={form.vatNumber} onChange={(e) => setForm({ ...form, vatNumber: e.target.value })} /></Field>
        <Field label="IBAN"><input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} /></Field>
      </div>
      {(form.type === "sales_partner" || form.type === "installation_partner") && (
        <div className="grid-2">
          <Field label="Selfbilling: voorvoegsel factuurnummer">
            <input value={form.selfBillingPrefix} maxLength={8} placeholder="automatisch uit de naam" onChange={(e) => setForm({ ...form, selfBillingPrefix: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Selfbilling: btw">
            <select value={form.selfBillingVatMode} onChange={(e) => setForm({ ...form, selfBillingVatMode: e.target.value })}>
              <option value="">Standaard ({form.type === "installation_partner" ? "verlegd" : "21%"})</option>
              <option value="normal">Btw volgens tarief (21%)</option>
              <option value="reverse_charge">Btw verlegd</option>
            </select>
          </Field>
        </div>
      )}
      <label className="checkbox"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Actief</label>
      {org?.type === "sales_partner" && <AdvisorsSection organizationId={org.id} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}

/** Adviseurs van een verkooppartner: per offerte vastgelegd, voor de fee-specificatie. */
function AdvisorsSection({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const advisors = useAdvisors(organizationId);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["advisors"] });
  const add = useMutation({
    mutationFn: () => api.post("/advisors", { organizationId, name, email: email || null }),
    onSuccess: async () => {
      setName("");
      setEmail("");
      await invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.patch(`/advisors/${id}`, { isActive }),
    onSuccess: invalidate,
  });
  return (
    <div style={{ marginTop: 16 }}>
      <div className="field">Adviseurs</div>
      <ErrorBox error={add.error ?? toggle.error} />
      {advisors.data?.map((a) => (
        <div key={a.id} className="row" style={{ justifyContent: "space-between", padding: "4px 0", opacity: a.isActive ? 1 : 0.5 }}>
          <span>{a.name} <span className="muted">{a.email}</span></span>
          <button className="btn small" onClick={() => toggle.mutate({ id: a.id, isActive: !a.isActive })}>{a.isActive ? "Deactiveren" : "Activeren"}</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 6, flexWrap: "nowrap" }}>
        <input placeholder="Naam" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <input placeholder="E-mail (optioneel)" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn small" disabled={!name} onClick={() => add.mutate()}>Toevoegen</button>
      </div>
    </div>
  );
}
