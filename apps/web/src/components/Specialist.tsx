import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { formatDate } from "../format";
import { Avatar } from "./Avatar";
import { ErrorBox, Field, Modal } from "./ui";

/** Klantspecialisten (B81): vaste contactpersoon per klant. */
export interface SpecialistRow {
  id: string;
  name: string;
  email: string | null;
  isActive: boolean;
  hasPhoto: boolean;
  acceptsNewCustomers: boolean;
  maxCustomers: number | null;
  customers: number;
  utilization: number | null;
}
export interface SpecialistOverview {
  specialists: SpecialistRow[];
  totals: { customers: number; capacity: number | null; utilization: number | null; warning: boolean; unassigned: number; withoutLimit: number };
  warningAt: number;
}

export const useSpecialists = (enabled = true) =>
  useQuery({ queryKey: ["specialists"], queryFn: () => api.get<SpecialistOverview>("/specialists"), enabled });

/** Pasfoto of initialen. */
export function SpecialistAvatar({ id, name, hasPhoto, size = 32 }: { id: string; name: string; hasPhoto: boolean; size?: number }) {
  return hasPhoto ? (
    <img src={`/api/public/specialists/${id}/photo`} alt="" width={size} height={size} style={{ borderRadius: "50%", objectFit: "cover", flex: "none" }} />
  ) : (
    <Avatar name={name} size={size} />
  );
}

/** Op de klantkaart: wie is de vaste contactpersoon; de manager kan wijzigen. */
export function SpecialistCell({
  customerId,
  specialist,
  serviceSince,
}: {
  customerId: string;
  specialist: { id: string; name: string; hasPhoto: boolean } | null;
  serviceSince: string | null;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
      {specialist ? (
        <>
          <SpecialistAvatar id={specialist.id} name={specialist.name} hasPhoto={specialist.hasPhoto} size={26} />
          <span>{specialist.name}</span>
        </>
      ) : serviceSince ? (
        <span className="badge">Service sinds {formatDate(serviceSince)}</span>
      ) : (
        <span className="muted">Nog niet gekoppeld</span>
      )}
      {can("specialists.manage") && (
        <button type="button" className="link" style={{ fontSize: 13 }} onClick={() => setOpen(true)}>Wijzigen</button>
      )}
      {open && <ChangeSpecialist customerId={customerId} currentId={specialist?.id ?? null} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ChangeSpecialist({ customerId, currentId, onClose }: { customerId: string; currentId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useSpecialists();
  const [userId, setUserId] = useState(currentId ?? "");
  const [notify, setNotify] = useState(true);
  const save = useMutation({
    meta: { toast: "Klantspecialist gewijzigd" },
    mutationFn: () => api.put(`/customers/${customerId}/specialist`, { userId: userId || null, notify }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["customer", customerId] });
      await qc.invalidateQueries({ queryKey: ["specialists"] });
      onClose();
    },
  });
  return (
    <Modal title="Klantspecialist" onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Specialist">
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Geen (ontkoppelen)</option>
          {list.data?.specialists.filter((s) => s.isActive).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.customers}{s.maxCustomers ? ` / ${s.maxCustomers}` : ""} klanten)
            </option>
          ))}
        </select>
      </Field>
      {userId && userId !== currentId && (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Klant een bericht sturen met de nieuwe contactpersoon
        </label>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Annuleren</button>
        <button className="btn primary" disabled={save.isPending || userId === (currentId ?? "")} onClick={() => save.mutate()}>Opslaan</button>
      </div>
    </Modal>
  );
}

/** Pasfoto kiezen: verkleind tot 256×256 in de browser (klein genoeg voor e-mail). */
export async function photoToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Kon de afbeelding niet lezen"));
      i.src = url;
    });
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Knop "Pasfoto" voor de specialist zelf (sidebar). */
export function OwnPhotoButton() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    meta: { toast: "Pasfoto opgeslagen" },
    mutationFn: (photoDataUrl: string) => api.patch(`/specialists/${me!.id}`, { photoDataUrl }),
    onSuccess: () => qc.invalidateQueries(),
    onError: setError,
  });
  return (
    <label className="btn small" style={{ cursor: "pointer" }} title={error instanceof Error ? error.message : "Foto die klanten zien in het welkomstbericht"}>
      Pasfoto
      <input
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) save.mutate(await photoToDataUrl(f));
          e.target.value = "";
        }}
      />
    </label>
  );
}
