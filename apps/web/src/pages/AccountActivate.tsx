import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, Field, Loading } from "../components/ui";

interface InviteInfo {
  name: string;
  email: string | null;
  organizationName: string;
  mfaRequired: boolean;
}

/** Account activeren via de uitnodiging: zelf een wachtwoord instellen (daarna inloggen en 2FA instellen). */
export function AccountActivatePage() {
  const { token = "" } = useParams();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<InviteInfo>(`/public/invites/${token}`), retry: false });
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const accept = useMutation({ mutationFn: () => api.post(`/public/invites/${token}`, { password }) });
  const mismatch = repeat.length > 0 && repeat !== password;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length >= 12 && !mismatch) accept.mutate();
  };
  return (
    <div className="auth-wrap">
      <div className="auth-card card">
        <div className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        {info.isLoading ? <Loading /> : info.error ? (
          <ErrorBox error={info.error} />
        ) : accept.isSuccess ? (
          <>
            <h2>Account geactiveerd</h2>
            <p>Log in met {info.data!.email} en uw nieuwe wachtwoord.{info.data!.mfaRequired && " U stelt daarna tweestapsverificatie in met een authenticator-app (bijvoorbeeld Google Authenticator of Microsoft Authenticator)."}</p>
            <a className="btn primary" href="/" style={{ display: "block", textAlign: "center" }}>Naar inloggen</a>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2>Welkom, {info.data!.name}</h2>
            <p className="muted">Stel een wachtwoord in voor uw account bij {info.data!.organizationName}. Uw inlognaam is {info.data!.email}.</p>
            <ErrorBox error={accept.error} />
            <Field label="Nieuw wachtwoord (minimaal 12 tekens)">
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </Field>
            <Field label="Herhaal wachtwoord">
              <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </Field>
            {mismatch && <p className="muted" style={{ color: "var(--danger)", fontSize: 13 }}>De wachtwoorden zijn niet gelijk.</p>}
            <button className="btn primary" style={{ width: "100%" }} disabled={password.length < 12 || repeat !== password || accept.isPending}>
              Wachtwoord instellen
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
