import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
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
  markLoginMethod("passkey");
}

export async function verifyWithPasskey() {
  const { challengeId, options } = await api.post<Options>("/auth/passkeys/verify/options");
  assertDomain(options.rpId);
  const response = await startAuthentication({ optionsJSON: options as never }).catch((e) => Promise.reject(friendly(e)));
  await api.post("/auth/passkeys/verify", { challengeId, response });
  // Bevestigd met Face ID: dit toestel heeft dus al een passkey; niet nog eens vragen om hem in te stellen.
  markLoginMethod("passkey");
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
  const { me } = useAuth();
  const add = useMutation({
    mutationFn: () => registerPasskey(name),
    onSuccess: async () => {
      if (me) markPasskeyDevice(me.id);
      await refresh();
    },
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

const promptKey = (userId: string) => `gecko-passkey-later-${userId}`;
const deviceKey = (userId: string) => `gecko-passkey-device-${userId}`;
const safe = <T,>(fn: () => T, fallback: T) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
/** Onthoudt per toestel dat hier een passkey is (of mee is ingelogd). */
export const markPasskeyDevice = (userId: string) => safe(() => localStorage.setItem(deviceKey(userId), "1"), undefined);
/** Hoe is in deze sessie ingelogd (alleen voor de vraag "ook op dit toestel?"). */
export const markLoginMethod = (method: "password" | "passkey") => safe(() => sessionStorage.setItem("gecko-login-method", method), undefined);

/**
 * Moet het "Face ID instellen"-scherm na het inloggen verschijnen?
 * - Nog geen enkele passkey: ja.
 * - Wel een passkey (bv. op de iPhone), maar nu met wachtwoord ingelogd op een toestel zonder passkey: ja ("ook op dit toestel?").
 * Niet bij "Inloggen als", zonder ondersteuning, op een ander domein, of na "Nu niet" in deze sessie.
 */
export function shouldPromptPasskey(me: { id: string; hasPasskey?: boolean; passkeyDomain?: string; impersonatedBy: unknown }): false | "first" | "device" {
  if (me.impersonatedBy || !passkeySupported()) return false;
  if (me.passkeyDomain && me.passkeyDomain !== location.hostname) return false;
  if (safe(() => sessionStorage.getItem(promptKey(me.id)), null) === "1") return false;
  if (!me.hasPasskey) return "first";
  const method = safe(() => sessionStorage.getItem("gecko-login-method"), null);
  if (method === "passkey") {
    // Met Face ID ingelogd of bevestigd: dit toestel onthouden, zodat de vraag hier niet meer komt.
    markPasskeyDevice(me.id);
    return false;
  }
  const viaPassword = method === "password";
  const knownDevice = safe(() => localStorage.getItem(deviceKey(me.id)), null) === "1";
  return viaPassword && !knownDevice ? "device" : false;
}

/**
 * Na het inloggen: Face ID instellen voor wie nog geen passkey heeft. "Nu niet" geldt voor deze sessie;
 * bij de volgende inlog komt de vraag terug.
 */
export function PasskeyPrompt({ userId, kind = "first", onDone }: { userId: string; kind?: "first" | "device"; onDone: () => Promise<void> | void }) {
  const [name, setName] = useState(deviceName());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const later = () => {
    try {
      sessionStorage.setItem(promptKey(userId), "1");
    } catch {
      // geen opslag: dan komt de vraag bij het volgende scherm terug; geen probleem
    }
    void onDone();
  };
  const setup = async () => {
    setError(null);
    setBusy(true);
    try {
      await registerPasskey(name);
      markPasskeyDevice(userId);
      await onDone();
    } catch (err) {
      if (!isCancelled(err)) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card card">
        <div className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        <h2>{kind === "device" ? "Ook op dit toestel Face ID gebruiken?" : "Stel Face ID in"}</h2>
        <p className="muted">
          {kind === "device"
            ? "Je logde hier in met je wachtwoord. Stel ook op dit toestel Face ID, Touch ID, je vingerafdruk of Windows Hello in, dan kan het voortaan zonder wachtwoord en zonder code."
            : "Log voortaan in met Face ID, Touch ID, je vingerafdruk of Windows Hello: zonder wachtwoord en zonder code. Veiliger en sneller. Je gezicht of vinger verlaat je toestel nooit."}
        </p>
        <ErrorBox error={error} />
        <label className="field" style={{ display: "block", marginBottom: 12 }}>
          <span>Naam van dit toestel</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
        </label>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void setup()} style={{ width: "100%", justifyContent: "center" }}>
          {busy ? "Wachten op Face ID…" : "Face ID instellen"}
        </button>
        <div style={{ marginTop: 12, textAlign: "center" }}>
          <button type="button" className="link" onClick={later} style={{ fontSize: 13 }}>Nu niet</button>
        </div>
      </div>
    </div>
  );
}
