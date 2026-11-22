import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { todayIso } from "../format";

const KEY = "gecko.werkdag";
const SEND_EVERY_MS = 60_000;

type State = "off" | "asking" | "on" | "denied" | "unavailable";
interface Ctx {
  state: State;
  start: () => void;
  stop: () => void;
}
const LocationCtx = createContext<Ctx>({ state: "off", start: () => undefined, stop: () => undefined });
export const useLocationSharing = () => useContext(LocationCtx);

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (v: string | null) => {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* privémodus */
  }
};

/**
 * B87: locatie van de monteur tijdens de werkdag. Draait op het niveau van het portaal, zodat het volgen
 * doorgaat als de monteur een klus opent. Eén tik op "Locatie aanzetten" vraagt meteen de toestemming van
 * de telefoon (moet direct na een tik, anders blokkeert iOS de vraag).
 */
export function LocationProvider({ children }: { children: ReactNode }) {
  const supported = typeof navigator !== "undefined" && "geolocation" in navigator;
  const [state, setState] = useState<State>(!supported ? "unavailable" : read() === todayIso() ? "on" : "off");
  const lastSent = useRef(0);

  const send = (p: GeolocationPosition, force = false) => {
    if (!force && Date.now() - lastSent.current < SEND_EVERY_MS) return;
    lastSent.current = Date.now();
    void api.post("/technician/location", { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }).catch(() => undefined);
  };

  useEffect(() => {
    if (state !== "on" || !supported) return;
    const id = navigator.geolocation.watchPosition(
      (p) => send(p),
      (e) => {
        if (e.code === e.PERMISSION_DENIED) {
          write(null);
          setState("denied");
        }
      },
      { enableHighAccuracy: true, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [state, supported]);

  const start = useCallback(() => {
    if (!supported) return setState("unavailable");
    setState("asking");
    // Direct in de tik: de telefoon toont nu de toestemmingsvraag.
    navigator.geolocation.getCurrentPosition(
      (p) => {
        write(todayIso());
        send(p, true);
        setState("on");
      },
      (e) => setState(e.code === e.PERMISSION_DENIED ? "denied" : "off"),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }, [supported]);

  const stop = useCallback(() => {
    write(null);
    setState("off");
  }, []);

  return <LocationCtx.Provider value={{ state, start, stop }}>{children}</LocationCtx.Provider>;
}

/** Balk bovenaan voor monteurs: één knop om de locatie aan te zetten, met hulp als de telefoon het blokkeert. */
export function LocationBar() {
  const { state, start, stop } = useLocationSharing();
  const [tries, setTries] = useState(0);
  if (state === "on") {
    return (
      <div className="loc-bar on" role="status">
        <span className="loc-dot" aria-hidden="true" />
        <span>Locatie staat aan</span>
        <button className="btn small" onClick={stop}>Werkdag beëindigen</button>
      </div>
    );
  }
  if (state === "denied") {
    return (
      <div className="loc-bar denied" role="alert">
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <strong>Locatie is geblokkeerd op dit apparaat.</strong>{" "}
          {tries > 0 && <span className="loc-still">Nog steeds geblokkeerd ({tries}×). Safari vraagt het niet opnieuw: zet het eerst aan via de stappen hieronder.</span>}
          <ol className="loc-help">
            <li><strong>iPhone / iPad (Safari):</strong> tik links in de adresbalk op het <em>paginamenu</em> (icoon met streepjes, op oudere versies <em>aA</em>) → <em>Website-instellingen</em> → <em>Locatie</em> → <em>Sta toe</em>.</li>
            <li>Staat daar geen Locatie of helpt het niet: open de app <em>Instellingen</em> → <em>Privacy en beveiliging</em> → <em>Locatievoorzieningen</em>: zet die <em>aan</em>, en zet <em>Safari-websites</em> op <em>Tijdens gebruik</em>.</li>
            <li><strong>Android (Chrome):</strong> tik op het icoon links naast het adres → <em>Machtigingen</em> → <em>Locatie</em> → <em>Toestaan</em>.</li>
            <li>Daarna: tik op <em>Pagina herladen</em> en dan op <em>Locatie aanzetten</em>.</li>
          </ol>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => window.location.reload()}>Pagina herladen</button>
          <button className="btn small primary" onClick={() => { setTries((n) => n + 1); start(); }}>Opnieuw proberen</button>
        </div>
      </div>
    );
  }
  if (state === "unavailable") return <div className="loc-bar denied">Deze browser kan geen locatie delen. Open het portaal in Safari of Chrome op je telefoon.</div>;
  return (
    <button className="loc-bar off" onClick={start} disabled={state === "asking"}>
      <span className="loc-pin" aria-hidden="true">📍</span>
      <span>
        <strong>{state === "asking" ? "Even wachten…" : "Locatie aanzetten"}</strong>
        <small>Start je werkdag. Klanten krijgen zo een betrouwbare aankomsttijd.</small>
      </span>
    </button>
  );
}
