import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Role } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { useRoles } from "../hooks";

interface PermissionInfo {
  key: string;
  description: string;
}

export function RolesPage() {
  const { can } = useAuth();
  const roles = useRoles();
  const perms = useQuery({ queryKey: ["permissions"], queryFn: () => api.get<PermissionInfo[]>("/permissions") });
  const [editing, setEditing] = useState<Role | "new" | null>(null);

  return (
    <>
      <PageHead
        title="Rollen & rechten"
        sub="Stel per rol in wat medewerkers mogen. De beheerder heeft altijd alle rechten."
        actions={can("roles.manage") && <button className="btn primary" onClick={() => setEditing("new")}>Nieuwe rol</button>}
      />
      <div className="card flush">
        {roles.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th>Rol</th><th>Rechten</th><th className="num">Gebruikers</th></tr></thead>
            <tbody>
              {roles.data?.map((r) => (
                <tr key={r.id} className={can("roles.manage") ? "clickable" : ""} onClick={() => can("roles.manage") && setEditing(r)}>
                  <td><strong>{r.name}</strong>{r.isSystem && <span className="badge" style={{ marginLeft: 6 }}>Systeem</span>}<div className="muted">{r.description}</div></td>
                  <td className="muted">{r.permissions.length} van {perms.data?.length ?? "…"}</td>
                  <td className="num">{r.userCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && perms.data && <RoleForm role={editing === "new" ? undefined : editing} permissions={perms.data} onClose={() => setEditing(null)} />}
    </>
  );
}

function RoleForm({ role, permissions, onClose }: { role?: Role; permissions: PermissionInfo[]; onClose: () => void }) {
  const qc = useQueryClient();
  const locked = role?.key === "beheerder";
  const [form, setForm] = useState({ key: role?.key ?? "", name: role?.name ?? "", description: role?.description ?? "", permissions: role?.permissions ?? [] });
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["roles"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      role
        ? api.patch(`/roles/${role.id}`, locked ? { name: form.name, description: form.description } : { name: form.name, description: form.description, permissions: form.permissions })
        : api.post("/roles", form),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/roles/${role!.id}`), onSuccess: invalidate });
  const toggle = (k: string) => setForm({ ...form, permissions: form.permissions.includes(k) ? form.permissions.filter((x) => x !== k) : [...form.permissions, k] });

  return (
    <Modal title={role ? `Rol: ${role.name}` : "Nieuwe rol"} onClose={onClose}>
      <ErrorBox error={save.error ?? remove.error} />
      <div className="grid-2">
        <Field label="Naam"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Sleutel"><input className="mono" value={form.key} disabled={!!role} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="bv. teamleider" /></Field>
      </div>
      <Field label="Omschrijving"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <div className="field">Rechten</div>
      {locked && <div className="alert info">De beheerder heeft altijd alle rechten.</div>}
      {permissions.map((p) => (
        <label key={p.key} className="checkbox">
          <input type="checkbox" disabled={locked} checked={locked || form.permissions.includes(p.key)} onChange={() => toggle(p.key)} />
          <span>{p.description} <span className="muted mono" style={{ fontSize: 11 }}>{p.key}</span></span>
        </label>
      ))}
      <div className="modal-actions">
        {role && !role.isSystem && <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => remove.mutate()}>Verwijderen</button>}
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}
