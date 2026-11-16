import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type User } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { formatDateTime } from "../format";
import { nameById, useOrganizations, useRoles, useUsers } from "../hooks";

export function UsersPage() {
  const { can } = useAuth();
  const users = useUsers();
  const roles = useRoles();
  const orgs = useOrganizations(can("organizations.read"));
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const { me } = useAuth();
  const adminRoleId = roles.data?.find((r) => r.key === "beheerder")?.id;
  const [impError, setImpError] = useState<unknown>(null);
  const impersonate = async (id: string) => {
    setImpError(null);
    try {
      await api.post(`/users/${id}/impersonate`);
      window.location.replace("/");
    } catch (e) {
      setImpError(e);
    }
  };

  return (
    <>
      <PageHead
        title="Gebruikers"
        sub="Iedereen die inlogt — medewerkers van Gecko en later partners."
        actions={can("users.manage") && <button className="btn primary" onClick={() => setEditing("new")}>Nieuwe gebruiker</button>}
      />
      <ErrorBox error={impError} />
      <div className="card flush">
        {users.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th>Naam</th><th>Organisatie</th><th>Rollen</th><th>2FA</th><th>Laatst ingelogd</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} className={can("users.manage") ? "clickable" : ""} onClick={() => can("users.manage") && setEditing(u)}>
                  <td><strong>{u.name}</strong><div className="muted">{[u.username, u.email].filter(Boolean).join(" · ")}</div></td>
                  <td>{nameById(orgs.data, u.organizationId)}</td>
                  <td>{u.roleIds.map((id) => <span key={id} className="badge" style={{ marginRight: 4 }}>{nameById(roles.data, id)}</span>)}</td>
                  <td>
                    {u.mfaEnabled ? <span className="badge green">Aan</span> : u.mfaRequired ? <span className="badge yellow">Nog instellen</span> : <span className="badge red">Uitgezet</span>}
                  </td>
                  <td>{formatDateTime(u.lastLoginAt)}</td>
                  <td>
                    {!u.isActive ? <span className="badge">Inactief</span> : u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <span className="badge red">Geblokkeerd</span> : <span className="badge green">Actief</span>}
                  </td>
                  <td className="num">
                    {can("users.impersonate") && u.isActive && u.id !== me?.id && !u.roleIds.includes(adminRoleId ?? "") && (
                      <button className="btn small" title="Bekijk en test het systeem zoals deze gebruiker het ziet" onClick={(e) => { e.stopPropagation(); void impersonate(u.id); }}>
                        Inloggen als
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <UserForm user={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserForm({ user, onClose }: { user?: User; onClose: () => void }) {
  const qc = useQueryClient();
  const roles = useRoles();
  const orgs = useOrganizations();
  const [form, setForm] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    username: user?.username ?? "",
    mfaRequired: user?.mfaRequired ?? true,
    organizationId: user?.organizationId ?? "",
    password: "",
    isActive: user?.isActive ?? true,
    roleIds: user?.roleIds ?? [],
    advisorId: (user as (User & { advisorId?: string | null }) | undefined)?.advisorId ?? "",
  });
  const org = orgs.data?.find((o) => o.id === form.organizationId);
  const advisors = useQuery({
    queryKey: ["advisors", form.organizationId],
    queryFn: () => api.get<{ id: string; name: string }[]>(`/advisors?organizationId=${form.organizationId}`),
    enabled: org?.type === "sales_partner",
  });
  const [notice, setNotice] = useState<string | null>(null);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ["users"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      user
        ? api.patch(`/users/${user.id}`, {
            name: form.name,
            email: form.email || null,
            username: form.username || null,
            mfaRequired: form.mfaRequired,
            organizationId: form.organizationId,
            isActive: form.isActive,
            roleIds: form.roleIds,
            advisorId: org?.type === "sales_partner" ? form.advisorId || null : null,
          })
        : api.post("/users", { ...form, email: form.email || null, username: form.username || null, advisorId: org?.type === "sales_partner" ? form.advisorId || null : null }),
    onSuccess: done,
  });
  const action = useMutation({
    mutationFn: async (kind: "reset-mfa" | "unlock" | "reset-password") => {
      if (kind === "reset-password") {
        if (form.password.length < 4) throw new Error("Vul eerst een startwachtwoord in");
        await api.post(`/users/${user!.id}/reset-password`, { password: form.password });
        return "Startwachtwoord ingesteld; de gebruiker is overal uitgelogd en kiest bij de volgende login een eigen wachtwoord.";
      }
      await api.post(`/users/${user!.id}/${kind}`);
      return kind === "reset-mfa" ? "2FA gewist; de gebruiker stelt het bij de volgende login opnieuw in." : "Account gedeblokkeerd.";
    },
    onSuccess: async (msg) => {
      setNotice(msg);
      await qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const toggle = (id: string) => setForm({ ...form, roleIds: form.roleIds.includes(id) ? form.roleIds.filter((x) => x !== id) : [...form.roleIds, id] });

  return (
    <Modal title={user ? "Gebruiker wijzigen" : "Nieuwe gebruiker"} onClose={onClose}>
      <ErrorBox error={save.error ?? action.error} />
      {notice && <div className="alert info">{notice}</div>}
      <div className="grid-2">
        <Field label="Naam"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Gebruikersnaam"><input value={form.username} autoCapitalize="none" onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
      </div>
      <Field label="E-mail"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Organisatie">
        <select value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value })}>
          <option value="">Kies…</option>
          {orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
      {org?.type === "sales_partner" && (
        <Field label="Adviseur (leeg = ziet alle offertes van de verkooppartner)">
          <select value={form.advisorId} onChange={(e) => setForm({ ...form, advisorId: e.target.value })}>
            <option value="">— hele organisatie —</option>
            {advisors.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <Field label={user ? "Nieuw startwachtwoord (alleen bij resetten)" : "Startwachtwoord (gebruiker kiest bij eerste login een eigen wachtwoord)"}>
        <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </Field>
      <div className="field">Rollen</div>
      {roles.data?.map((r) => (
        <label key={r.id} className="checkbox"><input type="checkbox" checked={form.roleIds.includes(r.id)} onChange={() => toggle(r.id)} /> {r.name}</label>
      ))}
      <label className="checkbox" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={form.mfaRequired} onChange={(e) => setForm({ ...form, mfaRequired: e.target.checked })} />
        <span>Tweestapsverificatie verplicht {!form.mfaRequired && <span className="badge red">Afgeraden</span>}</span>
      </label>
      {user && <label className="checkbox"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Actief</label>}
      {user && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn small" onClick={() => action.mutate("reset-password")}>Wachtwoord resetten</button>
          <button className="btn small" onClick={() => action.mutate("reset-mfa")}>2FA resetten</button>
          <button className="btn small" onClick={() => action.mutate("unlock")}>Deblokkeren</button>
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Sluiten</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}
