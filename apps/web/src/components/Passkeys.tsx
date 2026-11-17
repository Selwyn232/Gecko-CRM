import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { formatDateTime } from "../format";
import { ErrorBox, Modal } from "./ui";

type Options = { challengeId: string; options: { rpId?: string; rp?: { id?: string } } & Record<string, unknown> };

export const passkeySupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

/** Naam voor het toestel, zodat de gebruiker zijn passkeys herkent. */
export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android-telefoon";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows-computer";
  return "Passkey";
}

/** Passkeys werken alleen op het domein waarvoor ze zijn gemaakt (bv. crm.gecko.nl). */
export class WrongDomainError extends Error {
  constructor(readonly domain: string) {
    super(`Face ID werkt alleen op ${domain}. Open het CRM via https://${domain}.`);
  }
}
function assertDomain(domain: string | undefined) {
  if (domain && domain !== location.hostname) throw new WrongDomainError(domain);
}
/** Geannuleerd door de gebruiker (Face ID afgebroken): geen foutmelding tonen. */
export const isCancelled = (e: unknown) => e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");
const friendly = (e: unknown) =>
  e instanceof WrongDomainError ? e : e instanceof Error && e.name === "InvalidStateError" ? new Error("Deze passkey staat al op dit toestel.") : e;

export async function loginWithPasskey() {
  const { challengeId, options } = await api.post<Options>("/auth/passkeys/login/options");
  assertDomain(options.rpId);
  const response = await startAuthentication({ optionsJSON: options as never }).catch((e) => Promise.reject(friendly(e)));
  await api.post("/auth/passkeys/login", { challengeId, response });
}

export async function verifyWithPasskey() {
  const { challengeId, options } = await api.post<Options>("/auth/passkeys/verify/options");
  assertDomain(options.rpId);
  const response = await startAuthentication({ optionsJSON: options as never }).catch((e) => Promise.reject(friendly(e)));
  await api.post("/auth/passkeys/verify", { challengeId, response });
}

/** Nieuwe passkey; geeft herstelcodes terug als dit de eerste 2FA-methode is. */
export async function registerPasskey(name: string) {
  const { challengeId, options } = await api.post<Options>("/auth/passkeys/register/options");
  assertDomain(options.rp?.id);
  const response = await startRegistration({ optionsJSON: options as never }).catch((e) => Promise.reject(friendly(e)));
  return api.post<{ recoveryCodes: string[] | null }>("/auth/passkeys/register", { challengeId, name, response });
}

interface PasskeyRow {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Beheer: eigen passkeys bekijken, toevoegen en verwijderen. */
export function PasskeysModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["passkeys"], queryFn: () => api.get<PasskeyRow[]>("/auth/passkeys") });
  const [name, setName] = useState(deviceName());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["passkeys"] });
  const add = useMutation({
    mutationFn: () => registerPasskey(name),
    onSuccess: refresh,
    onError: () => undefined,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/auth/passkeys/${id}`),
    onSuccess: async () => {
      setConfirmRemove(null);
      await refresh();
    },
  });
  const addError = add.error && !isCancelled(add.error) ? add.error : null;
  return (
    <Modal title="Face ID en passkeys" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Log in met Face ID, Touch ID, je vingerafdruk of Windows Hello, zonder wachtwoord en zonder code. Voeg een passkey toe op elk toestel waarmee je werkt. Op een iPhone of Mac wordt hij via iCloud ook op je andere Apple-toestellen gezet.
      </p>
      <ErrorBox error={addError ?? remove.error} />
      {!list.data?.length ? (
        <div className="empty" style={{ padding: "12px 0" }}>Nog geen passkeys.</div>
      ) : (
        list.data.map((p) => (
          <div key={p.id} className="row" style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <div>
              <strong>{p.name}</strong>
              <div className="muted" style={{ fontSize: 12 }}>
                Toegevoegd {formatDateTime(p.createdAt)}
                {p.lastUsedAt ? ` · laatst gebruikt ${formatDateTime(p.lastUsedAt)}` : " · nog niet gebruikt"}
                {p.backedUp ? " · gesynchroniseerd" : ""}
              </div>
            </div>
            {confirmRemove === p.id ? (
              <span className="row" style={{ gap: 6 }}>
                <button className="btn small danger" onClick={() => remove.mutate(p.id)}>Verwijderen</button>
                <button className="btn small" onClick={() => setConfirmRemove(null)}>Annuleren</button>
              </span>
            ) : (
              <button className="btn small" onClick={() => setConfirmRemove(p.id)}>Verwijderen</button>
            )}
          </div>
        ))
      )}
      {passkeySupported() ? (
        <div className="row" style={{ marginTop: 14, flexWrap: "nowrap" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Naam van dit toestel" style={{ flex: 1, minWidth: 0 }} />
          <button className="btn primary" disabled={add.isPending || !name.trim()} onClick={() => add.mutate()}>Passkey toevoegen</button>
        </div>
      ) : (
        <div className="alert warning" style={{ marginTop: 12 }}>Deze browser ondersteunt geen passkeys.</div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Sluiten</button>
      </div>
    </Modal>
  );
}

/** Knop in de zijbalk/kop: "Face ID" (beheer). */
export function PasskeysButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small" onClick={() => setOpen(true)}>Face ID</button>
      {open && <PasskeysModal onClose={() => setOpen(false)} />}
    </>
  );
}
