import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SalesChannel } from "../api";
import { useAuth } from "../auth";
import { ActiveBadge, ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { nameById, useChannels, useOrganizations, useProductGroups } from "../hooks";

export function ChannelsPage() {
  const { can } = useAuth();
  const channels = useChannels();
  const groups = useProductGroups();
  const orgs = useOrganizations(can("organizations.read"));
  const [editing, setEditing] = useState<SalesChannel | "new" | null>(null);

  return (
    <>
      <PageHead
        title="Verkoopkanalen"
        sub="Elk kanaal heeft eigen productgroepen en een eigen prijslijst."
        actions={can("catalog.manage") && <button className="btn primary" onClick={() => setEditing("new")}>Nieuw kanaal</button>}
      />
      <div className="card flush">
        {channels.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th>Naam</th><th>Verkooppartner</th><th>Fee</th><th>Productgroepen</th><th>Status</th></tr></thead>
            <tbody>
              {channels.data?.map((c) => (
                <tr key={c.id} className={can("catalog.manage") ? "clickable" : ""} onClick={() => can("catalog.manage") && setEditing(c)}>
                  <td><strong>{c.name}</strong> <span className="muted mono">{c.key}</span></td>
                  <td>{c.salesPartnerOrganizationId ? nameById(orgs.data, c.salesPartnerOrganizationId) : <span className="muted">Eigen kanaal</span>}</td>
                  <td>{c.feeBasisPoints == null ? <span className="muted">—</span> : `${c.feeBasisPoints / 100}%`}</td>
                  <td>{c.productGroupIds.map((id) => <span key={id} className="badge" style={{ marginRight: 4 }}>{nameById(groups.data, id)}</span>)}</td>
                  <td><ActiveBadge active={c.isActive} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ChannelForm channel={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ChannelForm({ channel, onClose }: { channel?: SalesChannel; onClose: () => void }) {
  const qc = useQueryClient();
  const groups = useProductGroups();
  const orgs = useOrganizations();
  const [form, setForm] = useState({
    key: channel?.key ?? "",
    name: channel?.name ?? "",
    salesPartnerOrganizationId: channel?.salesPartnerOrganizationId ?? "",
    fee: channel?.feeBasisPoints == null ? "" : String(channel.feeBasisPoints / 100).replace(".", ","),
    quoteValidityDays: channel?.quoteValidityDays ?? 30,
    isActive: channel?.isActive ?? true,
    productGroupIds: channel?.productGroupIds ?? [],
  });
  const save = useMutation({
    mutationFn: () => {
      const { fee, ...rest } = form;
      const feeNum = fee.trim() === "" ? null : Math.round(Number(fee.replace(",", ".")) * 100);
      if (feeNum !== null && (Number.isNaN(feeNum) || feeNum < 0 || feeNum > 10000)) throw new Error("Ongeldig fee-percentage");
      const body = { ...rest, feeBasisPoints: feeNum, salesPartnerOrganizationId: form.salesPartnerOrganizationId || null };
      if (channel) {
        const { key: _key, ...rest } = body;
        return api.patch(`/sales-channels/${channel.id}`, rest);
      }
      return api.post("/sales-channels", body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-channels"] });
      onClose();
    },
  });
  const toggle = (id: string) =>
    setForm({ ...form, productGroupIds: form.productGroupIds.includes(id) ? form.productGroupIds.filter((x) => x !== id) : [...form.productGroupIds, id] });

  return (
    <Modal title={channel ? "Kanaal wijzigen" : "Nieuw kanaal"} onClose={onClose}>
      <ErrorBox error={save.error} />
      <div className="grid-2">
        <Field label="Naam"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Sleutel"><input className="mono" value={form.key} disabled={!!channel} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="bv. web" /></Field>
      </div>
      <Field label="Verkooppartner">
        <select value={form.salesPartnerOrganizationId} onChange={(e) => setForm({ ...form, salesPartnerOrganizationId: e.target.value })}>
          <option value="">Geen (eigen kanaal)</option>
          {orgs.data?.filter((o) => o.type === "sales_partner").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
      <div className="grid-2">
        <Field label="Fee verkooppartner (% over orderwaarde ex btw)"><input value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} placeholder="bv. 5" /></Field>
        <Field label="Geldigheid offerte (dagen)"><input type="number" min={1} max={365} value={form.quoteValidityDays} onChange={(e) => setForm({ ...form, quoteValidityDays: Number(e.target.value) })} /></Field>
      </div>
      <div className="field">Productgroepen</div>
      {groups.data?.map((g) => (
        <label key={g.id} className="checkbox"><input type="checkbox" checked={form.productGroupIds.includes(g.id)} onChange={() => toggle(g.id)} /> {g.name}</label>
      ))}
      <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Actief</label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}
