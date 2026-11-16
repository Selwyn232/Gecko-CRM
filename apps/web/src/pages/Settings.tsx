import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, PageHead } from "../components/ui";

interface Setting {
  key: string;
  label: string;
  default: number | boolean;
  value: number | boolean;
  isDefault: boolean;
}

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Setting[]>("/settings") });
  if (settings.isLoading) return <Loading />;
  return (
    <>
      <PageHead title="Instellingen" sub="Termijnen en percentages. Wijzigingen gelden direct voor nieuwe facturen en aanmaningen en staan in het logboek." />
      <div className="card flush">
        <table>
          <thead><tr><th>Instelling</th><th>Waarde</th><th className="muted">Standaard</th></tr></thead>
          <tbody>{settings.data?.map((s) => <SettingRow key={s.key} s={s} />)}</tbody>
        </table>
      </div>
    </>
  );
}

function SettingRow({ s }: { s: Setting }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(s.value));
  const save = useMutation({
    mutationFn: (v: number | boolean) => api.put(`/settings/${s.key}`, { value: v }),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
  return (
    <tr>
      <td>{s.label}<ErrorBox error={save.error} /></td>
      <td>
        {typeof s.default === "boolean" ? (
          <input type="checkbox" checked={Boolean(s.value)} onChange={(e) => save.mutate(e.target.checked)} />
        ) : (
          <input type="number" style={{ width: 100 }} value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => Number(value) !== s.value && save.mutate(Number(value))} />
        )}
      </td>
      <td className="muted">{String(s.default)}</td>
    </tr>
  );
}
