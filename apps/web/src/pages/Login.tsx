import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field } from "../components/ui";

/** Inloggen in stappen: wachtwoord → 2FA instellen (eerste keer) of 2FA-code → (eenmalig) herstelcodes tonen. */
export function LoginPage() {
  const { me, refresh } = useAuth();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  let step: "password" | "setup" | "verify" | "codes" | "newPassword" = "password";
  if (recoveryCodes) step = "codes";
  else if (me && !me.mfaVerified && !me.mfaEnabled) step = "setup";
  else if (me && !me.mfaVerified) step = "verify";
  else if (me?.mustChangePassword) step = "newPassword";

  return (
    <div className="auth-wrap">
      <div className="auth-card card">
        <div className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        {step === "password" && <PasswordStep onDone={refresh} />}
        {step === "setup" && <SetupStep onDone={setRecoveryCodes} />}
        {step === "verify" && <VerifyStep onDone={refresh} />}
        {step === "codes" && <CodesStep codes={recoveryCodes!} onDone={async () => { setRecoveryCodes(null); await refresh(); }} />}
        {step === "newPassword" && <NewPasswordStep onDone={refresh} />}
      </div>
    </div>
  );
}

function PasswordStep({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/login", { email, password });
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Inloggen</h2>
      <ErrorBox error={error} />
      <Field label="Gebruikersnaam of e-mailadres">
        <input value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
      </Field>
      <Field label="Wachtwoord">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      <button className="btn primary" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
        {busy ? "Bezig…" : "Inloggen"}
      </button>
    </form>
  );
}

function SetupStep({ onDone }: { onDone: (codes: string[]) => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .post<{ secret: string; otpauthUrl: string }>("/auth/mfa/setup")
      .then(async (r) => {
        setSecret(r.secret);
        setQr(await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }));
      })
      .catch(setError);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/mfa/enable", { code: code.replace(/\s/g, "") });
      onDone(r.recoveryCodes);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Tweestapsverificatie instellen</h2>
      <p className="muted">
        Scan de QR-code met een authenticator-app (bijv. Google Authenticator, Microsoft Authenticator of 1Password) en vul de code
        van 6 cijfers in.
      </p>
      <ErrorBox error={error} />
      {qr && <img className="qr" src={qr} width={200} height={200} alt="QR-code voor authenticator-app" />}
      {secret && (
        <p className="muted" style={{ fontSize: 12, textAlign: "center" }}>
          Of voer handmatig in: <span className="mono">{secret}</span>
        </p>
      )}
      <Field label="Code uit de app">
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
      </Field>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>
        Bevestigen
      </button>
    </form>
  );
}

function VerifyStep({ onDone }: { onDone: () => Promise<void> }) {
  const { logout } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/auth/mfa/verify", useRecovery ? { recoveryCode: value } : { code: value.replace(/\s/g, "") });
      await onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Verificatie</h2>
      <p className="muted">{useRecovery ? "Vul een van je herstelcodes in." : "Vul de code uit je authenticator-app in."}</p>
      <ErrorBox error={error} />
      <Field label={useRecovery ? "Herstelcode" : "Code"}>
        <input value={value} onChange={(e) => setValue(e.target.value)} autoComplete="one-time-code" required autoFocus />
      </Field>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>
        Verifiëren
      </button>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
        <button type="button" className="btn small" onClick={() => setUseRecovery(!useRecovery)}>
          {useRecovery ? "Code uit app gebruiken" : "Herstelcode gebruiken"}
        </button>
        <button type="button" className="btn small" onClick={logout}>
          Annuleren
        </button>
      </div>
    </form>
  );
}

function CodesStep({ codes, onDone }: { codes: string[]; onDone: () => Promise<void> }) {
  return (
    <div>
      <h2>Bewaar je herstelcodes</h2>
      <div className="alert warning">
        Deze codes worden maar één keer getoond. Ben je je telefoon kwijt, dan log je hiermee in. Elke code werkt één keer.
      </div>
      <div className="codes mono">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => void onDone()}>
        Ik heb ze bewaard
      </button>
    </div>
  );
}

function NewPasswordStep({ onDone }: { onDone: () => Promise<void> }) {
  const { logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError("De nieuwe wachtwoorden zijn niet gelijk");
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      await onDone();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form onSubmit={submit}>
      <h2>Kies een eigen wachtwoord</h2>
      <p className="muted">Je bent ingelogd met een startwachtwoord. Kies een eigen wachtwoord van minimaal 12 tekens.</p>
      <ErrorBox error={error} />
      <Field label="Huidig (start)wachtwoord"><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus /></Field>
      <Field label="Nieuw wachtwoord"><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} /></Field>
      <Field label="Herhaal nieuw wachtwoord"><input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></Field>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Opslaan</button>
      <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={logout}>Annuleren</button></div>
    </form>
  );
}
