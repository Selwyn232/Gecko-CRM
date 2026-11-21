import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type SalesChannel } from "../api";
import { useAuth } from "../auth";
import { ActiveBadge, ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { nameById, useChannels, useOrganizations, useProductGroups } from "../hooks";

/** Basispunten als Nederlands percentage: 650 → "6,5%". */
const pctLabel = (bp: number) => `${String(bp / 100).replace(".", ",")}%`;

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
            <thead><tr><th>Naam</th><th>Verkooppartner</th><th>Fee</th><th>Productgroepen en fee</th><th>Status</th></tr></thead>
            <tbody>
              {channels.data?.map((c) => (
                <tr key={c.id} className={can("catalog.manage") ? "clickable" : ""} onClick={() => can("catalog.manage") && setEditing(c)}>
                  <td><strong>{c.name}</strong> <span className="muted mono">{c.key}</span></td>
                  <td>{c.salesPartnerOrganizationId ? nameById(orgs.data, c.salesPartnerOrganizationId) : <span className="muted">Eigen kanaal</span>}</td>
                  <td>{c.feeBasisPoints == null ? <span className="muted">—</span> : `${pctLabel(c.feeBasisPoints)} standaard`}</td>
                  <td>
                    {c.productGroupIds.map((id) => {
                      const own = c.groupFees?.[id] ?? null;
                      const fee = own ?? c.feeBasisPoints;
                      return (
                        <span key={id} className={`badge ${own != null ? "green" : ""}`} style={{ marginRight: 4 }} title={own != null ? "Eigen fee voor deze productgroep" : "Standaard fee van het kanaal"}>
                          {nameById(groups.data, id)}{fee != null && ` · ${pctLabel(fee)}`}
                        </span>
                      );
                    })}
                  </td>
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
    installationLeadDays: channel?.installationLeadDays?.toString() ?? "",
    isActive: channel?.isActive ?? true,
    productGroupIds: channel?.productGroupIds ?? [],
  });
  const pct = (bp: number | null | undefined) => (bp == null ? "" : String(bp / 100).replace(".", ","));
  const [groupFees, setGroupFees] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(channel?.groupFees ?? {}).map(([k, v]) => [k, pct(v)])),
  );
  const save = useMutation({
    mutationFn: () => {
      const { fee, ...rest } = form;
      const feeNum = fee.trim() === "" ? null : Math.round(Number(fee.replace(",", ".")) * 100);
      if (feeNum !== null && (Number.isNaN(feeNum) || feeNum < 0 || feeNum > 10000)) throw new Error("Ongeldig fee-percentage");
      const parse = (v: string, label: string) => {
        if (v.trim() === "") return null;
        const n = Math.round(Number(v.replace(",", ".")) * 100);
        if (Number.isNaN(n) || n < 0 || n > 10000) throw new Error(`Ongeldig fee-percentage bij ${label}`);
        return n;
      };
      const fees = Object.fromEntries(
        form.productGroupIds.map((id) => [id, parse(groupFees[id] ?? "", groups.data?.find((g) => g.id === id)?.name ?? "productgroep")]),
      );
      const lead = form.installationLeadDays.trim() === "" ? null : Number(form.installationLeadDays);
      if (lead !== null && (!Number.isInteger(lead) || lead < 0 || lead > 365)) throw new Error("Ongeldig aantal dagen voor de installatie");
      const body = { ...rest, installationLeadDays: lead, feeBasisPoints: feeNum, groupFees: fees, salesPartnerOrganizationId: form.salesPartnerOrganizationId || null };
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
        <Field label="Standaard fee (% over orderwaarde ex btw)"><input value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} placeholder="bv. 5" /></Field>
        <Field label="Geldigheid offerte (dagen)"><input type="number" min={1} max={365} value={form.quoteValidityDays} onChange={(e) => setForm({ ...form, quoteValidityDays: Number(e.target.value) })} /></Field>
        <Field label="Installatie op zijn vroegst na (dagen na binnenkomst order; leeg = algemene instelling)">
          <input type="number" min={0} max={365} value={form.installationLeadDays} onChange={(e) => setForm({ ...form, installationLeadDays: e.target.value })} />
        </Field>
      </div>
      <div className="field">Productgroepen en fee per productgroep</div>
      {groups.data?.map((g) => (
        <div key={g.id} className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", marginBottom: 4 }}>
          <label className="checkbox" style={{ margin: 0 }}><input type="checkbox" checked={form.productGroupIds.includes(g.id)} onChange={() => toggle(g.id)} /> {g.name}</label>
          {form.productGroupIds.includes(g.id) && (
            <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
              <input
                aria-label={`Fee ${g.name}`}
                style={{ width: 80, textAlign: "right" }}
                value={groupFees[g.id] ?? ""}
                placeholder={form.fee ? form.fee : "—"}
                onChange={(e) => setGroupFees({ ...groupFees, [g.id]: e.target.value })}
              />
              <span className="muted">%</span>
            </span>
          )}
        </div>
      ))}
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Vink een productgroep aan om de fee in te vullen. Leeg = de standaard fee hierboven. De fee wordt per offerte vastgelegd bij het versturen; wijzigen geldt dus voor nieuwe offertes.</p>
      <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Actief</label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>Opslaan</button>
      </div>
    </Modal>
  );
}
