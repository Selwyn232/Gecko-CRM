import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type TechnicianJob } from "../api";
import { ErrorBox, Loading, PageHead } from "../components/ui";
import { addDaysIso, APPOINTMENT_TYPE, todayIso, weekday } from "../format";

const WORKDAY_KEY = "gecko.werkdag";
const SEND_EVERY_MS = 60_000;

function readWorkday(): string | null {
  try {
    return localStorage.getItem(WORKDAY_KEY);
  } catch {
    return null;
  }
}
function writeWorkday(v: string | null) {
  try {
    if (v) localStorage.setItem(WORKDAY_KEY, v);
    else localStorage.removeItem(WORKDAY_KEY);
  } catch {
    /* privémodus: alleen voor deze sessie */
  }
}

const position = () =>
  new Promise<{ lat: number; lng: number; accuracy: number } | null>((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });

const clock = (iso: string) => new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

/**
 * B87: dagplanning van de monteur. Werkdag starten = locatie delen tot "Werkdag beëindigen" (alleen zolang
 * deze pagina open is op de telefoon). Per klus: vertrekken (klant krijgt aankomsttijd), aanmelden, opleveren.
 */
export function TechnicianDay() {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIso());
  const day = useQuery({ queryKey: ["technician-day", date], queryFn: () => api.get<TechnicianJob[]>(`/technician/day?date=${date}`), refetchInterval: 60_000 });
  const [workday, setWorkday] = useState<string | null>(readWorkday() === todayIso() ? todayIso() : null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const lastSent = useRef(0);

  // Locatie volgen tijdens de werkdag (zolang de pagina open is).
  useEffect(() => {
    if (!workday || !("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGeoError(null);
        if (Date.now() - lastSent.current < SEND_EVERY_MS) return;
        lastSent.current = Date.now();
        void api.post("/technician/location", { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }).catch(() => undefined);
      },
      (e) => setGeoError(e.code === e.PERMISSION_DENIED ? "Locatie staat uit. Sta locatie toe voor deze website in de instellingen van je telefoon." : "Locatie tijdelijk niet beschikbaar."),
      { enableHighAccuracy: true, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [workday]);

  const startDay = () => {
    writeWorkday(todayIso());
    setWorkday(todayIso());
  };
  const endDay = () => {
    writeWorkday(null);
    setWorkday(null);
  };

  const action = useMutation({
    mutationFn: async ({ job, kind }: { job: TechnicianJob; kind: "en-route" | "check-in" }) => {
      const loc = await position();
      return api.post<{ etaAt?: string | null }>(`/technician/appointments/${job.id}/${kind}`, loc);
    },
    meta: { toast: "Doorgegeven" },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["technician-day"] }),
  });

  const jobs = day.data ?? [];
  const isToday = date === todayIso();
  return (
    <>
      <PageHead title="Mijn dag" sub="Je klussen op volgorde. Tik op 'Ik vertrek' als je naar de klant rijdt: de klant krijgt dan de verwachte aankomsttijd." />
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" onClick={() => setDate(addDaysIso(date, -1))}>←</button>
            <strong>{weekday(date)}</strong>
            <button className="btn small" onClick={() => setDate(addDaysIso(date, 1))}>→</button>
            {!isToday && <button className="btn small" onClick={() => setDate(todayIso())}>Vandaag</button>}
          </div>
          {workday ? (
            <button className="btn small" onClick={endDay}>Werkdag beëindigen</button>
          ) : (
            <button className="btn primary small" onClick={startDay}>Werkdag starten</button>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
          {workday
            ? "Je locatie wordt gedeeld met Gecko en je werkgever zolang deze pagina open is, tot je de werkdag beëindigt. Locaties worden na 7 dagen verwijderd."
            : "Start je werkdag om je locatie te delen; daarmee krijgen klanten een betrouwbare aankomsttijd."}
        </p>
        {geoError && <div className="alert warning" style={{ marginTop: 8 }}>{geoError}</div>}
      </div>
      <ErrorBox error={day.error ?? action.error} />
      {day.isLoading ? <Loading /> : !jobs.length ? (
        <div className="empty">Geen klussen op deze dag.</div>
      ) : (
        <div className="tech-jobs">
          {jobs.map((j, i) => {
            const done = j.status === "completed";
            return (
              <div key={j.id} className={`card tech-job ${done ? "done" : ""}`}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <strong style={{ fontSize: 17 }}>{j.time}</strong>
                  <span className="badge">{APPOINTMENT_TYPE[j.type] ?? j.type}{j.days > 1 ? ` · ${j.days} dagen` : ""}</span>
                </div>
                {i > 0 && j.travelMinutes != null && <div className="muted" style={{ fontSize: 12 }}>± {j.travelMinutes} min rijden vanaf de vorige klus</div>}
                <div style={{ marginTop: 6 }}>
                  <div>{j.customerName}</div>
                  <div className="muted">{j.address}</div>
                </div>
                <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <a className="btn small" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(j.address)}`} target="_blank" rel="noreferrer">Route</a>
                  {j.customerPhone && <a className="btn small" href={`tel:${j.customerPhone}`}>Bel klant</a>}
                  <Link className="btn small" to={`/afspraken/${j.id}`}>Details{done ? "" : " / opleveren"}</Link>
                </div>
                {!done && isToday && (
                  <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    {!j.enRouteAt ? (
                      <button className="btn primary" disabled={action.isPending} onClick={() => action.mutate({ job: j, kind: "en-route" })}>Ik vertrek</button>
                    ) : (
                      <span className="badge yellow">Onderweg sinds {clock(j.enRouteAt)}{j.etaAt ? ` · aankomst ± ${clock(j.etaAt)}` : ""}</span>
                    )}
                    {!j.checkedInAt ? (
                      <button className="btn" disabled={action.isPending} onClick={() => action.mutate({ job: j, kind: "check-in" })}>Aangekomen (aanmelden)</button>
                    ) : (
                      <span className="badge green">Aangemeld {clock(j.checkedInAt)}</span>
                    )}
                  </div>
                )}
                {done && <div className="badge green" style={{ marginTop: 8 }}>Afgemeld{j.checkedOutAt ? ` ${clock(j.checkedOutAt)}` : ""}</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
