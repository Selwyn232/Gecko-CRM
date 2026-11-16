import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, Field, Loading, PageHead, StatusPill } from "../components/ui";
import { formatCents, formatDate, formatPercent, todayIso } from "../format";
import { useProductGroups } from "../hooks";

interface StatusTime { id: string; name: string; phase: string; color: string; isFinal: boolean; done: number; avgDays: number | null; medianDays: number | null; current: number; currentAvgDays: number | null }
interface LeadGroup { productGroup: { id: string; name: string }; total: { projects: number; avgDays: number | null; medianDays: number | null }; statuses: StatusTime[] }
interface MarginRow { key: string | null; name: string; projects: number; revenueCents: number; revenueKnownCents: number; costCents: number | null; feeCents: number; marginCents: number | null; marginBasisPoints: number | null; incompleteQuotes: number }
interface Overview {
  leadTimes: LeadGroup[];
  stuck: { projectId: string; projectNumber: string; customerName: string; productGroupName: string; status: { name: string; color: string }; days: number }[];
  partners: { partnerId: string; name: string; surveyReports: number; installationsReviewed: number; firstTimeRight: number; firstTimeRightBasisPoints: number | null; rejectedReports: number; completedAppointments: number; noShows: number; penaltiesCents: number }[] | null;
  margins: {
    productGroups: MarginRow[];
    channels: MarginRow[];
    partners: MarginRow[];
    settled: { partnerId: string; name: string; type: string; feeCents: number; partnerCents: number; penaltiesCents: number; correctionsCents: number }[];
  } | null;
  cashflow: {
    weeks: { weekStart: string; receivablesCents: number; expectedCents: number; payablesCents: number; netCents: number; cumulativeCents: number }[];
    overdueCents: number;
    laterInCents: number;
    unplannedCents: number;
    payables: { approvedCents: number; awaitingApprovalCents: number; readyToBillCents: number };
  } | null;
}

type Preset = "all" | "month" | "prev_month" | "quarter" | "year" | "custom";
const PRESETS: Record<Preset, string> = { all: "Alles", month: "Deze maand", prev_month: "Vorige maand", quarter: "Dit kwartaal", year: "Dit jaar", custom: "Zelf kiezen" };

function range(p: Preset, custom: { from: string; to: string }): { from?: string; to?: string } {
  const t = todayIso();
  const [y, m] = t.split("-").map(Number) as [number, number];
  const iso = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  switch (p) {
    case "month": return { from: iso(y, m, 1), to: t };
    case "prev_month": { const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; return { from: iso(py, pm, 1), to: iso(py, pm, lastDay(py, pm)) }; }
    case "quarter": return { from: iso(y, Math.floor((m - 1) / 3) * 3 + 1, 1), to: t };
    case "year": return { from: iso(y, 1, 1), to: t };
    case "custom": return { from: custom.from || undefined, to: custom.to || undefined };
    default: return {};
  }
}

const days = (d: number | null) => (d === null ? "—" : `${d.toLocaleString("nl-NL", { maximumFractionDigits: d < 10 ? 1 : 0 })} d`);

export function ReportsPage() {
  const groups = useProductGroups();
  const [preset, setPreset] = useState<Preset>("all");
  const [custom, setCustom] = useState({ from: "", to: todayIso() });
  const [groupId, setGroupId] = useState("");
  const [stuckDays, setStuckDays] = useState(14);
  const r = range(preset, custom);
  const qs = new URLSearchParams({ ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}), ...(groupId ? { productGroupId: groupId } : {}), stuckDays: String(stuckDays) });
  const data = useQuery({ queryKey: ["reports", qs.toString()], queryFn: () => api.get<Overview>(`/reports/overview?${qs}`), placeholderData: (prev) => prev });

  return (
    <>
      <PageHead title="Rapportages" sub="Doorlooptijd, waar projecten blijven hangen, marge, kwaliteit van installateurs en de cashflow voor de komende 8 weken." />
      <div className="card row" style={{ alignItems: "flex-end", gap: 12 }}>
        <Field label="Periode">
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {preset === "custom" && (
          <>
            <Field label="Van"><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></Field>
            <Field label="Tot en met"><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></Field>
          </>
        )}
        <Field label="Productgroep">
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">Alle</option>
            {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="Blijft hangen na (dagen)">
          <input type="number" min={1} max={365} value={stuckDays} style={{ width: 90 }} onChange={(e) => setStuckDays(Math.max(1, Number(e.target.value) || 14))} />
        </Field>
      </div>
      <ErrorBox error={data.error} />
      {!data.data ? <Loading /> : <ReportBody d={data.data} stuckDays={stuckDays} />}
    </>
  );
}

function ReportBody({ d, stuckDays }: { d: Overview; stuckDays: number }) {
  const running = d.leadTimes.reduce((s, g) => s + g.statuses.reduce((x, st) => x + st.current, 0), 0);
  const finished = d.leadTimes.reduce((s, g) => s + g.total.projects, 0);
  const avgTotal = finished ? d.leadTimes.reduce((s, g) => s + (g.total.avgDays ?? 0) * g.total.projects, 0) / finished : null;
  const revenue = d.margins?.productGroups.reduce((s, m) => s + m.revenueCents, 0) ?? null;
  const known = d.margins?.productGroups.filter((m) => m.marginCents !== null) ?? [];
  const marginTotal = known.reduce((s, m) => s + m.marginCents!, 0);
  const marginBase = known.reduce((s, m) => s + m.revenueKnownCents, 0);
  const cf = d.cashflow;
  return (
    <>
      <div className="kpis">
        <Kpi label="Lopende projecten" value={String(running)} sub={`${d.stuck.length} langer dan ${stuckDays} d in dezelfde status`} />
        <Kpi label="Doorlooptijd tot afgerond" value={days(avgTotal)} sub={`gemiddeld, ${finished} afgerond`} />
        {revenue !== null && <Kpi label="Omzet (akkoord, excl. btw)" value={formatCents(revenue)} />}
        {d.margins && <Kpi label="Marge (voorcalculatie)" value={marginBase ? formatPercent(Math.round((marginTotal * 10000) / marginBase)) : "—"} sub={marginBase ? `${formatCents(marginTotal)}${marginBase < (revenue ?? 0) ? ", alleen offertes met kostprijs" : ""}` : "geen bekende kostprijs"} />}
        {cf && <Kpi label="Te ontvangen (open facturen)" value={formatCents(cf.weeks.reduce((s, w) => s + w.receivablesCents, 0) + cf.laterInCents)} sub={cf.overdueCents ? `waarvan ${formatCents(cf.overdueCents)} achterstallig` : "niets achterstallig"} />}
        {cf && <Kpi label="Netto 8 weken" value={formatCents(cf.weeks.at(-1)!.cumulativeCents)} sub="in minus uit, incl. btw" />}
      </div>

      <LeadTimes groups={d.leadTimes} />
      <Stuck items={d.stuck} stuckDays={stuckDays} />
      {d.margins && <Margins m={d.margins} />}
      {d.partners && <Partners rows={d.partners} />}
      {cf && <Cashflow cf={cf} />}
    </>
  );
}

const Kpi = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>
);

function LeadTimes({ groups }: { groups: LeadGroup[] }) {
  const [gid, setGid] = useState<string | null>(null);
  const g = groups.find((x) => x.productGroup.id === gid) ?? groups[0];
  if (!g) return null;
  const rows = g.statuses.filter((s) => !s.isFinal);
  const max = Math.max(1, ...rows.map((s) => s.avgDays ?? 0));
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 0" }}>
        <h2 style={{ margin: 0 }}>Doorlooptijd per status</h2>
        <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>
          Hoe lang projecten in elke status bleven (statussen verlaten in de gekozen periode), en hoeveel er nu in staan.
          {g.total.projects > 0 && <> Opdracht tot afgerond: gemiddeld <strong>{days(g.total.avgDays)}</strong>, mediaan {days(g.total.medianDays)} ({g.total.projects} projecten).</>}
        </p>
        {groups.length > 1 && (
          <div className="tabs" style={{ marginBottom: 0 }}>
            {groups.map((x) => <button key={x.productGroup.id} className={x.productGroup.id === g.productGroup.id ? "active" : ""} onClick={() => setGid(x.productGroup.id)}>{x.productGroup.name}</button>)}
          </div>
        )}
      </div>
      <table>
        <thead><tr><th>Fase</th><th>Status</th><th>Gemiddeld</th><th style={{ width: "26%" }} /><th className="num">Mediaan</th><th className="num">Doorlopen</th><th className="num">Nu in status</th><th className="num">Gem. al</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="muted">{s.phase}</td>
              <td><StatusPill status={s} /></td>
              <td className="num" style={{ textAlign: "left" }}>{days(s.avgDays)}</td>
              <td title={s.avgDays !== null ? `${s.name}: gemiddeld ${days(s.avgDays)} over ${s.done} projecten` : "Nog geen gegevens"}>
                <div className="hbar"><span style={{ width: `${((s.avgDays ?? 0) / max) * 100}%`, display: s.avgDays === null ? "none" : undefined }} /></div>
              </td>
              <td className="num">{days(s.medianDays)}</td>
              <td className="num">{s.done}</td>
              <td className="num">{s.current || <span className="muted">0</span>}</td>
              <td className="num">{s.current ? days(s.currentAvgDays) : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stuck({ items, stuckDays }: { items: Overview["stuck"]; stuckDays: number }) {
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}>
        <h2 style={{ margin: 0 }}>Blijft hangen</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Lopende projecten die langer dan {stuckDays} dagen in dezelfde status staan, langst wachtend eerst.</p>
      </div>
      {!items.length ? <div className="empty">Geen projecten die blijven hangen.</div> : (
        <table>
          <thead><tr><th>Project</th><th>Klant</th><th>Productgroep</th><th>Status</th><th className="num">Dagen</th></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.projectId}>
                <td className="mono"><Link to={`/projecten/${s.projectId}`}>{s.projectNumber}</Link></td>
                <td>{s.customerName}</td>
                <td>{s.productGroupName}</td>
                <td><StatusPill status={s.status} /></td>
                <td className="num"><strong>{s.days}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Margins({ m }: { m: NonNullable<Overview["margins"]> }) {
  const [dim, setDim] = useState<"productGroups" | "channels" | "partners">("productGroups");
  const rows = m[dim];
  const incomplete = rows.reduce((s, r) => s + r.incompleteQuotes, 0);
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 0" }}>
        <h2 style={{ margin: 0 }}>Marge (voorcalculatie)</h2>
        <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>
          Geaccepteerde offertes (incl. meerwerk) in de periode, met de kostprijs en fee zoals vastgelegd bij het versturen. Marge = omzet − kostprijs − fee verkoopkanaal.
        </p>
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={dim === "productGroups" ? "active" : ""} onClick={() => setDim("productGroups")}>Per productgroep</button>
          <button className={dim === "channels" ? "active" : ""} onClick={() => setDim("channels")}>Per verkoopkanaal</button>
          <button className={dim === "partners" ? "active" : ""} onClick={() => setDim("partners")}>Per installateur</button>
        </div>
      </div>
      {!rows.length ? <div className="empty">Geen geaccepteerde offertes in deze periode.</div> : (
        <table>
          <thead><tr><th /><th className="num">Projecten</th><th className="num">Omzet</th><th className="num">Kostprijs</th><th className="num">Fee</th><th className="num">Marge</th><th className="num">Marge %</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key ?? "none"}>
                <td>{r.name}{r.incompleteQuotes > 0 && <span className="badge yellow" style={{ marginLeft: 6 }} title="Kostprijs onbekend: deze offertes tellen wel mee in de omzet, niet in kostprijs en marge">{r.incompleteQuotes} zonder kostprijs</span>}</td>
                <td className="num">{r.projects}</td>
                <td className="num">{formatCents(r.revenueCents)}</td>
                <td className="num">{formatCents(r.costCents)}</td>
                <td className="num">{formatCents(r.feeCents)}</td>
                <td className="num"><strong>{formatCents(r.marginCents)}</strong></td>
                <td className="num">{r.marginBasisPoints !== null ? formatPercent(r.marginBasisPoints) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {incomplete > 0 && <p className="muted" style={{ padding: "8px 20px", fontSize: 13 }}>Vul ontbrekende inkoopprijzen en partnertarieven in bij Producten om de marge volledig te maken.</p>}
      {m.settled.length > 0 && (
        <>
          <div style={{ padding: "12px 20px 4px" }}><strong>Werkelijk afgerekend via selfbilling</strong> <span className="muted" style={{ fontSize: 13 }}>(definitieve facturen in de periode, excl. btw)</span></div>
          <table>
            <thead><tr><th>Partner</th><th className="num">Fee</th><th className="num">Installatie en meerwerk</th><th className="num">Boetes ingehouden</th><th className="num">Correcties</th></tr></thead>
            <tbody>
              {m.settled.map((s) => (
                <tr key={s.partnerId}>
                  <td>{s.name}</td>
                  <td className="num">{s.feeCents ? formatCents(s.feeCents) : "—"}</td>
                  <td className="num">{s.partnerCents ? formatCents(s.partnerCents) : "—"}</td>
                  <td className="num">{s.penaltiesCents ? formatCents(s.penaltiesCents) : "—"}</td>
                  <td className="num">{s.correctionsCents ? formatCents(s.correctionsCents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Partners({ rows }: { rows: NonNullable<Overview["partners"]> }) {
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}>
        <h2 style={{ margin: 0 }}>Installateurs</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>First-time-right = opleverrapport in één keer goedgekeurd (nooit afgekeurd). Rapporten, afspraken en boetes in de gekozen periode.</p>
      </div>
      {!rows.length ? <div className="empty">Nog geen installatiepartners.</div> : (
        <table>
          <thead><tr><th>Installateur</th><th className="num">Schouwrapporten</th><th className="num">Opleveringen beoordeeld</th><th className="num">First-time-right</th><th className="num">Rapporten afgekeurd</th><th className="num">Afspraken uitgevoerd</th><th className="num">Niet gekomen</th><th className="num">Boetes</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.partnerId}>
                <td>{p.name}</td>
                <td className="num">{p.surveyReports}</td>
                <td className="num">{p.installationsReviewed}</td>
                <td className="num"><strong>{p.firstTimeRightBasisPoints !== null ? formatPercent(p.firstTimeRightBasisPoints) : "—"}</strong>{p.installationsReviewed > 0 && <span className="muted" style={{ fontSize: 12 }}> ({p.firstTimeRight}/{p.installationsReviewed})</span>}</td>
                <td className="num">{p.rejectedReports}</td>
                <td className="num">{p.completedAppointments}</td>
                <td className="num">{p.noShows ? <span className="badge red">{p.noShows}</span> : 0}</td>
                <td className="num">{p.penaltiesCents ? formatCents(p.penaltiesCents) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Cashflow({ cf }: { cf: NonNullable<Overview["cashflow"]> }) {
  const weeks = cf.weeks.map((w) => ({ ...w, in: w.receivablesCents + w.expectedCents }));
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.in, w.payablesCents)));
  const label = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
  return (
    <div className="card flush">
      <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
        <div>
          <h2 style={{ margin: 0 }}>Cashflowprognose (8 weken, incl. btw)</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            In: open facturen op vervaldatum (achterstallig in deze week) en nog te factureren bedragen op installatiedatum + betaaltermijn. Uit: selfbilling aan Greenteam en installateurs.
          </p>
        </div>
        <div className="legend"><span><i style={{ background: "var(--series-1)" }} />In</span><span><i style={{ background: "var(--series-2)" }} />Uit</span></div>
      </div>
      <div className="cf-chart" role="img" aria-label="Staafdiagram in en uit per week; de tabel eronder bevat dezelfde cijfers">
        {weeks.map((w) => (
          <div className="cf-week" key={w.weekStart}>
            <div className="bar in" style={{ height: `${(w.in / max) * 100}%` }} />
            <div className="bar out" style={{ height: `${(w.payablesCents / max) * 100}%` }} />
            <div className="tip">
              <strong>Week van {label(w.weekStart)}</strong><br />
              In: {formatCents(w.in)}<br />
              Uit: {formatCents(w.payablesCents)}<br />
              Netto: {formatCents(w.netCents)}
            </div>
          </div>
        ))}
      </div>
      <div className="cf-axis">{weeks.map((w) => <div key={w.weekStart}>{label(w.weekStart)}</div>)}</div>
      <table style={{ marginTop: 12 }}>
        <thead><tr><th>Week van</th><th className="num">Open facturen</th><th className="num">Nog te factureren</th><th className="num">Uit (selfbilling)</th><th className="num">Netto</th><th className="num">Cumulatief</th></tr></thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.weekStart}>
              <td>{formatDate(w.weekStart)}</td>
              <td className="num">{formatCents(w.receivablesCents)}</td>
              <td className="num">{formatCents(w.expectedCents)}</td>
              <td className="num">{formatCents(w.payablesCents)}</td>
              <td className="num">{formatCents(w.netCents)}</td>
              <td className="num"><strong>{formatCents(w.cumulativeCents)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ padding: "12px 20px", gap: 24, fontSize: 13 }}>
        <span>Achterstallig (in week 1): <strong>{formatCents(cf.overdueCents)}</strong></span>
        <span>Na 8 weken: <strong>{formatCents(cf.laterInCents)}</strong></span>
        <span>Nog te factureren, installatie niet gepland: <strong>{formatCents(cf.unplannedCents)}</strong></span>
      </div>
      <div className="row" style={{ padding: "0 20px 14px", gap: 24, fontSize: 13 }} >
        <span className="muted">Uit bestaat uit:</span>
        <span>geaccordeerd {formatCents(cf.payables.approvedCents)}</span>
        <span>wacht op akkoord {formatCents(cf.payables.awaitingApprovalCents)}</span>
        <span>nog te factureren (excl. btw) {formatCents(cf.payables.readyToBillCents)}</span>
      </div>
    </div>
  );
}
