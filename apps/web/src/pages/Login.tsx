import QRCode from "qrcode";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
        {step === "setup" && <MethodChoice smsAllowed={!!me?.smsAllowed} onDone={setRecoveryCodes} />}
        {step === "verify" && (me?.mfaMethod === "sms" ? <SmsVerifyStep phone={me.smsPhone ?? null} onDone={refresh} /> : <VerifyStep onDone={refresh} />)}
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

/** Eerste keer 2FA: kies app of sms (alleen als sms voor deze gebruiker is toegestaan). */
function MethodChoice({ smsAllowed, onDone }: { smsAllowed: boolean; onDone: (codes: string[]) => void }) {
  const { logout } = useAuth();
  const [method, setMethod] = useState<"app" | "sms" | null>(smsAllowed ? null : "app");
  if (method === "app") return <SetupStep onDone={onDone} onBack={smsAllowed ? () => setMethod(null) : undefined} />;
  if (method === "sms") return <SmsSetupStep onDone={onDone} onBack={() => setMethod(null)} />;
  return (
    <div>
      <h2>Tweestapsverificatie instellen</h2>
      <p className="muted">Naast je wachtwoord vragen we bij het inloggen om een code. Kies hoe je die wilt ontvangen.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button className="btn method-choice" onClick={() => setMethod("app")}>
          <strong>Authenticator-app (aanbevolen)</strong>
          <span className="muted">Code in een app op je telefoon, zoals Google of Microsoft Authenticator. Werkt ook zonder bereik.</span>
        </button>
        <button className="btn method-choice" onClick={() => setMethod("sms")}>
          <strong>Sms naar mijn mobiel</strong>
          <span className="muted">Je krijgt bij het inloggen een code per sms.</span>
        </button>
      </div>
      <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={logout}>Annuleren</button></div>
    </div>
  );
}

function SmsSetupStep({ onDone, onBack }: { onDone: (codes: string[]) => void; onBack: () => void }) {
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<{ phone: string }>("/auth/mfa/sms/setup", { phone });
      setSentTo(r.phone);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/mfa/sms/enable", { code: code.replace(/\s/g, "") });
      onDone(r.recoveryCodes);
    } catch (err) {
      setError(err);
    }
  };

  return sentTo ? (
    <form onSubmit={confirm}>
      <h2>Code invullen</h2>
      <p className="muted">We hebben een code van 6 cijfers gestuurd naar {sentTo}. De code is 5 minuten geldig.</p>
      <ErrorBox error={error} />
      <Field label="Code uit de sms">
        <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
      </Field>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Bevestigen</button>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
        <button type="button" className="btn small" onClick={() => void send()} disabled={busy}>Nieuwe code sturen</button>
        <button type="button" className="btn small" onClick={() => { setSentTo(null); setCode(""); }}>Ander nummer</button>
      </div>
    </form>
  ) : (
    <form onSubmit={send}>
      <h2>Sms instellen</h2>
      <p className="muted">Vul je mobiele nummer in. We sturen een code om het nummer te bevestigen.</p>
      <ErrorBox error={error} />
      <Field label="Mobiel nummer">
        <input type="tel" inputMode="tel" autoComplete="tel" placeholder="06 12345678" value={phone} onChange={(e) => setPhone(e.target.value)} required autoFocus />
      </Field>
      <button className="btn primary" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>{busy ? "Versturen…" : "Stuur code"}</button>
      <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={onBack}>Terug</button></div>
    </form>
  );
}

/** Inloggen met sms: de code wordt direct verstuurd; herstelcode blijft mogelijk. */
function SmsVerifyStep({ phone, onDone }: { phone: string | null; onDone: () => Promise<void> }) {
  const { logout } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sentOnce = useRef(false);

  const send = async () => {
    setError(null);
    try {
      const r = await api.post<{ phone: string }>("/auth/mfa/sms/send");
      setNotice(`Code verstuurd naar ${r.phone}. Geldig 5 minuten.`);
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    if (sentOnce.current) return;
    sentOnce.current = true;
    void send();
  }, []);

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
      <p className="muted">{useRecovery ? "Vul een van je herstelcodes in." : notice ?? `We sturen een code per sms${phone ? ` naar ${phone}` : ""}…`}</p>
      <ErrorBox error={error} />
      <Field label={useRecovery ? "Herstelcode" : "Code uit de sms"}>
        <input inputMode={useRecovery ? "text" : "numeric"} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="one-time-code" required autoFocus />
      </Field>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>Verifiëren</button>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 12, gap: 8 }}>
        {!useRecovery && <button type="button" className="btn small" onClick={() => void send()}>Nieuwe code sturen</button>}
        <button type="button" className="btn small" onClick={() => setUseRecovery(!useRecovery)}>{useRecovery ? "Code per sms" : "Herstelcode gebruiken"}</button>
        <button type="button" className="btn small" onClick={logout}>Annuleren</button>
      </div>
    </form>
  );
}

function SetupStep({ onDone, onBack }: { onDone: (codes: string[]) => void; onBack?: () => void }) {
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
      {onBack && <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={onBack}>Terug</button></div>}
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
