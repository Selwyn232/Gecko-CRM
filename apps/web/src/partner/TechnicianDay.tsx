import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type TechnicianJob } from "../api";
import { ErrorBox, Loading, PageHead } from "../components/ui";
import { addDaysIso, APPOINTMENT_TYPE, todayIso, weekday } from "../format";

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
 * B87: dagplanning van de monteur (locatie aan/uit staat in de balk erboven, LocationSharing).
 * Per klus: vertrekken (klant krijgt aankomsttijd), aanmelden, opleveren.
 */
export function TechnicianDay() {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayIso());
  const day = useQuery({ queryKey: ["technician-day", date], queryFn: () => api.get<TechnicianJob[]>(`/technician/day?date=${date}`), refetchInterval: 60_000 });

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
        </div>
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
