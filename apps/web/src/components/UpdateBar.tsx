import { useEffect, useState } from "react";

const CHECK_EVERY_MS = 5 * 60_000;

/**
 * Meldt dat er een nieuwe versie van het CRM live staat (na een deploy), zodat een tabblad dat lang open
 * staat niet met oude schermen tegen de nieuwe server praat. Controleert bij terugkomen in het tabblad
 * en elke 5 minuten; ververst pas als de gebruiker op de knop klikt (geen werk kwijt).
 */
export function UpdateBar() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const check = async () => {
      try {
        const res = await fetch("/version.json", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (version && version !== __APP_VERSION__) setAvailable(true);
      } catch {
        // Offline of server even weg: volgende keer opnieuw.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  if (!available) return null;
  return (
    <div className="update-bar" role="status">
      <span>Er staat een nieuwe versie van Gecko CRM klaar. Sla eventueel je werk op en ververs de pagina.</span>
      <button className="btn small primary" onClick={() => window.location.reload()}>Verversen</button>
    </div>
  );
}
