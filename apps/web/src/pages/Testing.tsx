import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Field, PageHead } from "../components/ui";
import { useChannels, useProductGroups } from "../hooks";

interface Scenario {
  projectId: string;
  customerId: string;
  quoteId: string;
  partnerId: string;
  partnerUserId: string;
  technicianUserId?: string;
  regionName: string;
  salesChannelName?: string;
  feeBasisPoints?: number | null;
}

const STORAGE_KEY = "gecko-test-scenario";
const loadLast = (): Scenario | null => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
};

/** Testpagina: testmodus, testscenario aanmaken en het hele proces stap voor stap doorlopen. */
export function TestingPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const groups = useProductGroups();
  const channels = useChannels();
  const [channelId, setChannelId] = useState("");
  const status = useQuery({ queryKey: ["test-status"], queryFn: () => api.get<{ testMode: boolean }>("/testing/status") });
  const [groupId, setGroupId] = useState("");
  const [email, setEmail] = useState(me?.email ?? "");
  const [postalCode, setPostalCode] = useState("3511 AB");
  const [scenario, setScenario] = useState<Scenario | null>(loadLast);

  const toggle = useMutation({
    mutationFn: (on: boolean) => api.put("/settings/test.mode", { value: on }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["test-status"] }),
  });
  const create = useMutation({
    mutationFn: () => api.post<Scenario>("/testing/scenario", { productGroupId: groupId || groups.data?.[0]?.id, email, postalCode, salesChannelId: channelId || null }),
    onSuccess: (s) => {
      setScenario(s);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      } catch {
        /* geen opslag beschikbaar: alleen deze sessie */
      }
    },
  });
  const impersonate = async (as: "partner" | "monteur" = "partner") => {
    const id = as === "monteur" && scenario!.technicianUserId ? scenario!.technicianUserId : scenario!.partnerUserId;
    await api.post(`/users/${id}/impersonate`);
    window.location.replace("/");
  };
  const on = !!status.data?.testMode;

  return (
    <>
      <PageHead title="Testen" sub="Doorloop het hele proces — offerte, schouw, aanbetaling, rapport, meerwerk, installatie, oplevering, eindfactuur en selfbilling met akkoord — met een testklant, Greenteam (test) en testinstallateur." />

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>Testmodus {on ? <span className="badge" style={{ background: "#7c3aed", color: "#fff" }}>AAN</span> : <span className="badge">UIT</span>}</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>Aan: schouw en installatie kunnen vandaag al worden ingepland en de installateur kan het rapport direct indienen.</p>
          </div>
          <button className={`btn ${on ? "" : "primary"}`} onClick={() => toggle.mutate(!on)}>{on ? "Testmodus uitzetten" : "Testmodus aanzetten"}</button>
        </div>
        <ErrorBox error={toggle.error} />
      </div>

      <div className="card">
        <h2>1. Testscenario aanmaken</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Maakt een testklant met een geaccepteerde offerte en een project dat klaarstaat voor de schouw, plus de <strong>Testinstallateur (test)</strong> met werkgebied, beschikbaarheid voor de komende 14 dagen en een partnertarief. Standaard verkocht via <strong>Greenteam (test)</strong>: een testkopie met testadviseur en fee, zodat je ook de selfbilling kunt testen zonder de echte Greenteam aan te passen. Alle e-mails — ook de akkoordmails van de selfbilling — gaan naar het adres hieronder.
        </p>
        <ErrorBox error={create.error} />
        <div className="grid-2">
          <Field label="Productgroep">
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field label="E-mail testklant (ontvangt offerte, facturen en bevestigingen)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Postcode testadres"><input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} /></Field>
          <Field label="Verkoopkanaal">
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Greenteam (test) — met adviseur en fee, akkoordmails naar jou (aanbevolen)</option>
              {channels.data?.filter((c) => c.isActive && c.key !== "greenteam_test").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <button className="btn primary" disabled={!on || !email || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Bezig…" : "Testscenario aanmaken"}</button>
        {!on && <span className="muted" style={{ marginLeft: 8 }}>Zet eerst de testmodus aan.</span>}
      </div>

      {scenario && (
        <div className="card">
          <h2>2. Doorloop het proces</h2>
          <p className="muted" style={{ fontSize: 13 }}>Testproject in gebied <strong>{scenario.regionName}</strong>{scenario.salesChannelName && <>, verkocht via <strong>{scenario.salesChannelName}</strong>{scenario.feeBasisPoints != null && <> ({scenario.feeBasisPoints / 100}% fee)</>}</>}. Volg de stappen; als installateur werk je via <em>Inloggen als</em> (gele balk bovenin om terug te keren).</p>
          <ol className="steps">
            <li>
              <div><div className="who">Planner</div><strong>Schouw inplannen</strong><div className="muted">Op het project bij Afspraken → Schouw plannen. Kies een moment van Monteur Test (testinstallateur). Daarna gaat automatisch de aanbetalingsfactuur uit.</div></div>
              <Link className="btn small" to={`/projecten/${scenario.projectId}`}>Naar project</Link>
            </li>
            <li>
              <div><div className="who">Klant</div><strong>Aanbetaling betalen</strong><div className="muted">Open de factuur (op het project) → Opnieuw versturen → betaallink → testbetaling "geslaagd". Of registreer een betaling. Project gaat naar "Aanbetaling ontvangen".</div></div>
              <Link className="btn small" to={`/projecten/${scenario.projectId}`}>Naar project</Link>
            </li>
            <li>
              <div><div className="who">Monteur</div><strong>Schouwrapport indienen</strong><div className="muted">Mijn dag → Ik vertrek → Aangekomen → Details / opleveren → foto's, checklist en eventueel meerwerk → Rapport indienen.</div></div>
              <button className="btn small primary" onClick={() => void impersonate("monteur")}>Inloggen als monteur</button>
            </li>
            <li>
              <div><div className="who">Planner</div><strong>Schouwrapport beoordelen</strong><div className="muted">Planning → Rapporten. Met meerwerk ontstaat een meerwerk-offerte: definitief maken en versturen ter akkoord (de klant accepteert via de e-maillink).</div></div>
              <Link className="btn small" to="/planning">Naar planning</Link>
            </li>
            <li>
              <div><div className="who">Planner</div><strong>Installatie inplannen</strong><div className="muted">Planning → Installatie te plannen. 6 uur per dag bij dezelfde installateur; rijtijd wordt meegerekend.</div></div>
              <Link className="btn small" to="/planning">Naar planning</Link>
            </li>
            <li>
              <div><div className="who">Monteur</div><strong>Opleverrapport met handtekening klant</strong><div className="muted">Mijn dag → de installatie → serienummers, foto's, en laat de "klant" tekenen in het tekenvlak.</div></div>
              <button className="btn small primary" onClick={() => void impersonate("monteur")}>Inloggen als monteur</button>
            </li>
            <li>
              <div><div className="who">Planner</div><strong>Opleverrapport goedkeuren</strong><div className="muted">Daarna gaat automatisch de eindfactuur uit (incl. meerwerk, minus aanbetaling). Betaal die → project "Afgerond".</div></div>
              <Link className="btn small" to="/planning">Naar planning</Link>
            </li>
            <li>
              <div><div className="who">Finance</div><strong>Selfbilling Greenteam (kan al na stap 2)</strong><div className="muted">Selfbilling → Uit te betalen → Greenteam (test) → Conceptfactuur maken → Definitief maken en ter akkoord sturen.</div></div>
              <Link className="btn small" to="/selfbilling">Naar selfbilling</Link>
            </li>
            <li>
              <div><div className="who">Greenteam</div><strong>Akkoord geven</strong><div className="muted">Open de mail "Ter akkoord: selfbillingfactuur…" in je inbox → Factuur bekijken en akkoord geven. Probeer ook "Niet akkoord" en daarna in het CRM "Opnieuw ter akkoord sturen".</div></div>
            </li>
            <li>
              <div><div className="who">Finance</div><strong>Selfbilling installateur (na stap 7)</strong><div className="muted">Zelfde route voor Testinstallateur (test): partnertarief min eventuele boetes, btw verlegd. Akkoord via de mail, of via het portaal (Inloggen als → Uitbetalingen; mag alleen in testmodus).</div></div>
              <button className="btn small primary" onClick={() => void impersonate()}>Inloggen als testinstallateur (beheer)</button>
            </li>
            <li>
              <div><div className="who">Finance</div><strong>Uitbetalen</strong><div className="muted">Na akkoord: op de selfbillingfactuur → Markeren als betaald.</div></div>
              <Link className="btn small" to="/selfbilling">Naar selfbilling</Link>
            </li>
          </ol>
        </div>
      )}
    </>
  );
}
