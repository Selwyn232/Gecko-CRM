import QRCode from "qrcode";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { isCancelled, loginWithPasskey, passkeySupported, registerPasskey, deviceName, verifyWithPasskey } from "../components/Passkeys";
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
        {step === "setup" && <MethodChoice smsAllowed={!!me?.smsAllowed} passkeyDomain={me?.passkeyDomain ?? null} onDone={setRecoveryCodes} />}
        {step === "verify" &&
          (me?.mfaMethod === "sms" ? (
            <SmsVerifyStep phone={me.smsPhone ?? null} onDone={refresh} />
          ) : me?.mfaMethod === "passkey" ? (
            <PasskeyVerifyStep onDone={refresh} />
          ) : (
            <VerifyStep onDone={refresh} />
          ))}
        {step === "codes" && <CodesStep codes={recoveryCodes!} onDone={async () => { setRecoveryCodes(null); await refresh(); }} />}
        {step === "newPassword" && <NewPasswordStep onDone={refresh} />}
      </div>
    </div>
  );
}

/** "Wachtwoord vergeten?": e-mailadres invullen, herstellink per e-mail. Zegt nooit of het adres bestaat. */
function ForgotStep({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail.includes("@") ? initialEmail : "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/public/password-reset", { email });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (sent) {
    return (
      <div>
        <h2>Kijk in je mailbox</h2>
        <p className="muted">
          Als {email} bij een account hoort, ontvang je binnen een paar minuten een e-mail met een link om een nieuw wachtwoord in te stellen. De link is 1 uur geldig. Geen e-mail? Kijk in je spam, of vraag een beheerder om je wachtwoord te resetten.
        </p>
        <button className="btn" onClick={onBack} style={{ width: "100%", justifyContent: "center" }}>Terug naar inloggen</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit}>
      <h2>Wachtwoord vergeten</h2>
      <p className="muted">Vul het e-mailadres van je account in. Je krijgt een link om een nieuw wachtwoord in te stellen.</p>
      <ErrorBox error={error} />
      <Field label="E-mailadres">
        <input type="email" autoCapitalize="none" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </Field>
      <button className="btn primary" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>{busy ? "Versturen…" : "Stuur herstellink"}</button>
      <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={onBack}>Terug</button></div>
    </form>
  );
}

function PasswordStep({ onDone }: { onDone: () => Promise<void> }) {
  const [forgot, setForgot] = useState(false);
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

  if (forgot) return <ForgotStep initialEmail={email} onBack={() => setForgot(false)} />;
  return (
    <form onSubmit={submit}>
      <h2>Inloggen</h2>
      <ErrorBox error={error} />
      <Field label="E-mailadres">
        <input value={email} autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
      </Field>
      <Field label="Wachtwoord">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      <div style={{ textAlign: "right", margin: "-4px 0 12px" }}>
        <button type="button" className="link" onClick={() => setForgot(true)} style={{ fontSize: 13 }}>Wachtwoord vergeten?</button>
      </div>
      <button className="btn primary" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
        {busy ? "Bezig…" : "Inloggen"}
      </button>
      {passkeySupported() && <PasskeyLoginButton onDone={onDone} />}
    </form>
  );
}

/** Inloggen met alleen Face ID / passkey (geen wachtwoord, geen code). */
function PasskeyLoginButton({ onDone }: { onDone: () => Promise<void> }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginWithPasskey();
      await onDone();
    } catch (err) {
      if (!isCancelled(err)) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="or-divider"><span>of</span></div>
      <button type="button" className="btn" disabled={busy} onClick={() => void go()} style={{ width: "100%", justifyContent: "center" }}>
        {busy ? "Wachten op Face ID…" : "Inloggen met Face ID of passkey"}
      </button>
      <div style={{ marginTop: 8 }}><ErrorBox error={error} /></div>
    </div>
  );
}

/** Eerste keer 2FA: kies app of sms (alleen als sms voor deze gebruiker is toegestaan). */
function MethodChoice({ smsAllowed, passkeyDomain, onDone }: { smsAllowed: boolean; passkeyDomain: string | null; onDone: (codes: string[]) => void }) {
  const { logout } = useAuth();
  // Passkeys alleen aanbieden als de browser ze kent én we op het juiste domein zitten.
  const passkeyOk = passkeySupported() && (!passkeyDomain || passkeyDomain === location.hostname);
  const [method, setMethod] = useState<"passkey" | "app" | "sms" | null>(smsAllowed || passkeyOk ? null : "app");
  const back = smsAllowed || passkeyOk ? () => setMethod(null) : undefined;
  if (method === "passkey") return <PasskeySetupStep onDone={onDone} onBack={() => setMethod(null)} />;
  if (method === "app") return <SetupStep onDone={onDone} onBack={back} />;
  if (method === "sms") return <SmsSetupStep onDone={onDone} onBack={() => setMethod(null)} />;
  return (
    <div>
      <h2>Tweestapsverificatie instellen</h2>
      <p className="muted">Naast je wachtwoord vragen we een tweede bevestiging. Kies hoe je dat wilt doen.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {passkeyOk && (
          <button className="btn method-choice" onClick={() => setMethod("passkey")}>
            <strong>Face ID, Touch ID of vingerafdruk (aanbevolen)</strong>
            <span className="muted">Inloggen met je gezicht of vinger, zonder code. Daarna kun je ook zonder wachtwoord inloggen.</span>
          </button>
        )}
        <button className="btn method-choice" onClick={() => setMethod("app")}>
          <strong>Authenticator-app{passkeyOk ? "" : " (aanbevolen)"}</strong>
          <span className="muted">Code in een app op je telefoon, zoals Google of Microsoft Authenticator. Werkt ook zonder bereik.</span>
        </button>
        {smsAllowed && (
          <button className="btn method-choice" onClick={() => setMethod("sms")}>
            <strong>Sms naar mijn mobiel</strong>
            <span className="muted">Je krijgt bij het inloggen een code per sms.</span>
          </button>
        )}
      </div>
      <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={logout}>Annuleren</button></div>
    </div>
  );
}

function PasskeySetupStep({ onDone, onBack }: { onDone: (codes: string[]) => void; onBack: () => void }) {
  const [name, setName] = useState(deviceName());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await registerPasskey(name);
      onDone(r.recoveryCodes ?? []);
    } catch (err) {
      if (!isCancelled(err)) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <h2>Face ID instellen</h2>
      <p className="muted">Je toestel vraagt zo om Face ID, Touch ID, je vingerafdruk of je toegangscode. Er wordt niets van je gezicht of vinger naar Gecko gestuurd: dat blijft op je toestel.</p>
      <ErrorBox error={error} />
      <Field label="Naam van dit toestel">
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <button className="btn primary" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>{busy ? "Wachten op Face ID…" : "Face ID instellen"}</button>
      <div style={{ marginTop: 12 }}><button type="button" className="btn small" onClick={onBack}>Terug</button></div>
    </form>
  );
}

/** Na het wachtwoord: bevestigen met de passkey (of een herstelcode). */
function PasskeyVerifyStep({ onDone }: { onDone: () => Promise<void> }) {
  const { logout } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  if (useRecovery) return <VerifyStep onDone={onDone} recoveryOnly onBack={() => setUseRecovery(false)} />;
  return (
    <div>
      <h2>Verificatie</h2>
      <p className="muted">Bevestig met Face ID, Touch ID of je vingerafdruk.</p>
      <PasskeyVerifyButton onDone={onDone} primary />
      <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
        <button type="button" className="btn small" onClick={() => setUseRecovery(true)}>Herstelcode gebruiken</button>
        <button type="button" className="btn small" onClick={logout}>Annuleren</button>
      </div>
    </div>
  );
}

function PasskeyVerifyButton({ onDone, primary }: { onDone: () => Promise<void>; primary?: boolean }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      await verifyWithPasskey();
      await onDone();
    } catch (err) {
      if (!isCancelled(err)) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: primary ? 0 : 12 }}>
      <ErrorBox error={error} />
      <button type="button" className={`btn ${primary ? "primary" : ""}`} disabled={busy} onClick={() => void go()} style={{ width: "100%", justifyContent: "center" }}>
        {busy ? "Wachten op Face ID…" : "Gebruik Face ID of passkey"}
      </button>
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
  const { logout, me } = useAuth();
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
      {me?.hasPasskey && passkeySupported() && <PasskeyVerifyButton onDone={onDone} />}
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

function VerifyStep({ onDone, recoveryOnly, onBack }: { onDone: () => Promise<void>; recoveryOnly?: boolean; onBack?: () => void }) {
  const { logout, me } = useAuth();
  const [useRecovery, setUseRecovery] = useState(!!recoveryOnly);
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
        {recoveryOnly ? (
          <button type="button" className="btn small" onClick={onBack}>Terug</button>
        ) : (
          <button type="button" className="btn small" onClick={() => setUseRecovery(!useRecovery)}>
            {useRecovery ? "Code uit app gebruiken" : "Herstelcode gebruiken"}
          </button>
        )}
        <button type="button" className="btn small" onClick={logout}>
          Annuleren
        </button>
      </div>
      {!recoveryOnly && me?.hasPasskey && passkeySupported() && <PasskeyVerifyButton onDone={onDone} />}
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
