import { api } from "../api";
import { useAuth } from "../auth";

/** Altijd zichtbaar tijdens "Inloggen als", met één klik terug naar het eigen account. */
export function ImpersonationBar() {
  const { me } = useAuth();
  if (!me?.impersonatedBy) return null;
  const stop = async () => {
    await api.post("/auth/stop-impersonation").catch(() => undefined);
    window.location.replace("/gebruikers");
  };
  return (
    <div className="impersonation-bar">
      <span>
        👁 Je bent ingelogd als <strong>{me.name}</strong>
        {me.organizationName ? ` (${me.organizationName})` : ""} — alles wat je doet wordt vastgelegd op naam van {me.impersonatedBy.name}.
      </span>
      <button className="btn small" onClick={() => void stop()}>Terug naar mijn account</button>
    </div>
  );
}
