import { WithAvatar } from "../components/Avatar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Invite, type Organization } from "../api";
import { useAuth } from "../auth";
import { ActiveBadge, ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { formatDateTime, ORG_TYPES } from "../format";
import { nameById, useAdvisors, useOrganizations, useProductGroups, useUsers } from "../hooks";

export function OrganizationsPage() {
  const { can } = useAuth();
  const orgs = useOrganizations();
  const groups = useProductGroups();
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
            <thead><tr><th>Naam</th><th>Soort</th><th>Installeert</th><th>E-mail</th><th>Account</th><th>Status</th></tr></thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} className={can("organizations.manage") ? "clickable" : ""} onClick={() => can("organizations.manage") && setEditing(o)}>
                  <td><WithAvatar name={o.name} strong /></td>
                  <td>{ORG_TYPES[o.type]}</td>
                  <td>
                    {o.type !== "installation_partner" ? <span className="muted">—</span> : o.productGroupIds?.length ? (
                      o.productGroupIds.map((g) => <span key={g} className="badge" style={{ marginRight: 4 }}>{nameById(groups.data, g)}</span>)
                    ) : <span className="badge yellow">Nog niet ingesteld (alles)</span>}
                  </td>
                  <td>{o.email ?? "—"}</td>
                  <td>
                    {o.type === "installation_partner" && !o.userCount ? <span className="badge red">Geen account</span> : o.userCount ? <span className="muted">{o.userCount} gebruiker{o.userCount === 1 ? "" : "s"}</span> : <span className="muted">—</span>}
                  </td>
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
  const groups = useProductGroups();
  const [groupIds, setGroupIds] = useState<string[]>(org?.productGroupIds ?? []);
  const [account, setAccount] = useState({ name: "", email: "" });
  const [invite, setInvite] = useState<Invite | null>(null);
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
    crewCount: org?.crewCount ?? 1,
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
      const partner = form.type === "installation_partner";
      if (org) {
        const { type: _t, ...rest } = body;
        return api.patch<Organization & { invite?: Invite | null }>(`/organizations/${org.id}`, { ...rest, ...(partner ? { productGroupIds: groupIds } : {}) });
      }
      return api.post<Organization & { invite?: Invite | null }>("/organizations", partner ? { ...body, productGroupIds: groupIds, account } : body);
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["organizations"] });
      await qc.invalidateQueries({ queryKey: ["users"] });
      // Nieuwe partner: uitnodiging tonen (met link als e-mail niet verstuurd kon worden).
      if (!org && res.invite) setInvite(res.invite);
      else onClose();
    },
  });
  if (invite) return <InviteResult invite={invite} onClose={onClose} />;
  return (
    <Modal title={org ? "Organisatie wijzigen" : "Nieuwe organisatie"} onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Naam"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Soort">
        <select value={form.type} disabled={!!org} onChange={(e) => setForm({ ...form, type: e.target.value as Organization["type"] })}>
          {Object.entries(ORG_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      {form.type === "installation_partner" && (
        <div className="field-group" style={{ margin: "8px 0 12px" }}>
          <div className="field">Installeert (verplicht)</div>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {groups.data?.map((g) => (
              <label key={g.id} className="checkbox" style={{ margin: 0 }}>
                <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => setGroupIds(groupIds.includes(g.id) ? groupIds.filter((x) => x !== g.id) : [...groupIds, g.id])} /> {g.name}
              </label>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Alleen voor deze productgroepen wordt de partner voorgesteld en ingepland.</p>
          {!org && (
            <>
              <div className="field" style={{ marginTop: 12 }}>Account voor de partner (verplicht)</div>
              <div className="grid-2">
                <Field label="Naam contactpersoon"><input value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} /></Field>
                <Field label="E-mail contactpersoon (inlognaam)"><input type="email" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} /></Field>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>De partner krijgt een e-mail om zelf een wachtwoord in te stellen. Daarna ziet hij zijn opdrachten, geeft hij zijn beschikbaarheid door en levert hij rapporten aan.</p>
            </>
          )}
        </div>
      )}
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
      {form.type === "installation_partner" && (
        <Field label="Aantal ploegen (afspraken die tegelijk in één dagdeel passen)">
          <input type="number" min={1} max={20} value={form.crewCount} style={{ width: 90 }} onChange={(e) => setForm({ ...form, crewCount: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
        </Field>
      )}
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
      {org?.type === "installation_partner" && <PartnerAccounts org={org} />}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button
          className="btn primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || (form.type === "installation_partner" && (!groupIds.length || (!org && (!account.name.trim() || !account.email.trim()))))}
        >
          {!org && form.type === "installation_partner" ? "Opslaan en uitnodigen" : "Opslaan"}
        </button>
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

/** Na het aanmaken of opnieuw uitnodigen: verstuurd, of de link om zelf door te sturen. */
function InviteResult({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const sent = invite.emailStatus === "sent";
  return (
    <Modal title="Uitnodiging" onClose={onClose}>
      {sent ? (
        <div className="alert success">Uitnodiging verstuurd naar {invite.email}. De link is 7 dagen geldig.</div>
      ) : (
        <div className="alert warning">
          De e-mail naar {invite.email} is niet verstuurd ({invite.emailStatus === "not_sent" ? "geen e-mailkoppeling" : "versturen mislukt"}). Stuur deze link zelf door; hij werkt één keer en is 7 dagen geldig:
          <input readOnly value={invite.url} onFocus={(e) => e.target.select()} style={{ width: "100%", marginTop: 8 }} className="mono" />
        </div>
      )}
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>Sluiten</button>
      </div>
    </Modal>
  );
}

/** Accounts van een installatiepartner: aanmaken (als er nog geen is) en uitnodiging opnieuw sturen. */
function PartnerAccounts({ org }: { org: Organization }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const users = useUsers();
  const own = (users.data ?? []).filter((u) => u.organizationId === org.id && u.isActive);
  const [account, setAccount] = useState({ name: "", email: org.email ?? "" });
  const [invite, setInvite] = useState<Invite | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ invite: Invite }>(`/organizations/${org.id}/account`, account),
    onSuccess: async (r) => {
      setInvite(r.invite);
      await qc.invalidateQueries({ queryKey: ["users"] });
      await qc.invalidateQueries({ queryKey: ["organizations"] });
    },
  });
  const resend = useMutation({ meta: { toast: "Uitnodiging verstuurd" }, mutationFn: (id: string) => api.post<Invite>(`/users/${id}/invite`, {}), onSuccess: setInvite });
  if (!can("users.manage")) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="field">Account(s) van de partner</div>
      <ErrorBox error={create.error ?? resend.error} />
      {invite && <InviteResult invite={invite} onClose={() => setInvite(null)} />}
      {own.map((u) => (
        <div key={u.id} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
          <span>
            {u.name} <span className="muted">{u.email}</span>{" "}
            {u.lastLoginAt ? <span className="muted" style={{ fontSize: 12 }}>· laatst ingelogd {formatDateTime(u.lastLoginAt)}</span> : <span className="badge yellow">Nog niet geactiveerd</span>}
          </span>
          {u.email && <button className="btn small" onClick={() => resend.mutate(u.id)} disabled={resend.isPending}>Uitnodiging opnieuw sturen</button>}
        </div>
      ))}
      {!own.length && (
        <>
          <div className="alert warning" style={{ marginBottom: 6 }}>Deze partner heeft nog geen account. Zonder account kan hij geen opdrachten zien of beschikbaarheid doorgeven.</div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input placeholder="Naam contactpersoon" value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
            <input placeholder="E-mail" type="email" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
            <button className="btn small primary" disabled={!account.name.trim() || !account.email.trim() || create.isPending} onClick={() => create.mutate()}>Account aanmaken</button>
          </div>
        </>
      )}
    </div>
  );
}
