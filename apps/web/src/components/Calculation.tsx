import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { formatCents, formatPercent } from "../format";

export interface Calculation {
  projectId: string;
  components: { key: string; label: string; plannedCents: number; actualCents: number; basis: "actual" | "planned" | "partial"; note?: string }[];
  planned: { marginCents: number; marginBasisPoints: number | null };
  actual: { marginCents: number; marginBasisPoints: number | null };
  deviationCents: number;
  complete: boolean;
  missing: string[];
}

const BASIS: Record<string, { label: string; cls: string }> = {
  actual: { label: "werkelijk", cls: "green" },
  partial: { label: "deels", cls: "yellow" },
  planned: { label: "verwacht", cls: "" },
};

/** Afwijking met teken; positief = beter dan verwacht. */
export const Deviation = ({ cents }: { cents: number }) =>
  cents === 0 ? <span className="muted">—</span> : <span style={{ color: cents < 0 ? "var(--danger)" : "var(--accent)", fontWeight: 600 }}>{cents > 0 ? "+" : ""}{formatCents(cents)}</span>;

/** Voor- en nacalculatie op de projectkaart (alleen met recht op inkoopprijzen). */
export function ProjectCalculation({ projectId }: { projectId: string }) {
  const calc = useQuery({ queryKey: ["calculation", projectId], queryFn: () => api.get<Calculation>(`/projects/${projectId}/calculation`) });
  if (!calc.data) return null;
  const c = calc.data;
  return (
    <div className="card flush">
      <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
        <div>
          <h2 style={{ margin: 0 }}>Calculatie</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Voorcalculatie bij akkoord naast de nacalculatie (facturen en selfbilling), excl. btw. {c.complete ? "Nacalculatie is definitief." : "Wat nog niet is afgerekend, telt mee als verwacht."}
          </p>
        </div>
        <span className={`badge ${c.complete ? "green" : ""}`}>{c.complete ? "Afgerekend" : "Lopend"}</span>
      </div>
      <table>
        <thead><tr><th /><th className="num">Voorcalculatie</th><th className="num">Nacalculatie</th><th className="num">Afwijking</th><th /></tr></thead>
        <tbody>
          {c.components.map((k) => (
            <tr key={k.key}>
              <td>{k.label}{k.note && <div className="muted" style={{ fontSize: 12 }}>{k.note}</div>}</td>
              <td className="num">{formatCents(k.plannedCents)}</td>
              <td className="num">{formatCents(k.actualCents)}</td>
              <td className="num"><Deviation cents={k.actualCents - k.plannedCents} /></td>
              <td><span className={`badge ${BASIS[k.basis]!.cls}`}>{BASIS[k.basis]!.label}</span></td>
            </tr>
          ))}
          <tr style={{ borderTop: "2px solid var(--border)" }}>
            <td><strong>Marge</strong></td>
            <td className="num"><strong>{formatCents(c.planned.marginCents)}</strong>{c.planned.marginBasisPoints !== null && <div className="muted" style={{ fontSize: 12 }}>{formatPercent(c.planned.marginBasisPoints)}</div>}</td>
            <td className="num"><strong>{formatCents(c.actual.marginCents)}</strong>{c.actual.marginBasisPoints !== null && <div className="muted" style={{ fontSize: 12 }}>{formatPercent(c.actual.marginBasisPoints)}</div>}</td>
            <td className="num"><Deviation cents={c.deviationCents} /></td>
            <td />
          </tr>
        </tbody>
      </table>
      {c.missing.length > 0 && (
        <div className="alert warning" style={{ margin: "8px 20px 16px" }}>
          Onvolledig: {c.missing.join(", ")}.{c.missing.some((m) => m.includes("prijs") || m.includes("tarief")) && " Vul ontbrekende prijzen in bij Producten."}
        </div>
      )}
    </div>
  );
}

/** Marge per project op de klantkaart. */
export function CustomerMargins({ projects }: { projects: { id: string; displayNumber: string }[] }) {
  const results = useQueries({ queries: projects.map((p) => ({ queryKey: ["calculation", p.id], queryFn: () => api.get<Calculation>(`/projects/${p.id}/calculation`) })) });
  if (!projects.length) return null;
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Marge per project</h2></div>
      <table>
        <thead><tr><th>Project</th><th className="num">Omzet</th><th className="num">Marge voor</th><th className="num">Marge na</th><th className="num">Afwijking</th><th /></tr></thead>
        <tbody>
          {projects.map((p, i) => {
            const c = results[i]?.data;
            return (
              <tr key={p.id}>
                <td className="mono"><Link to={`/projecten/${p.id}`}>{p.displayNumber}</Link></td>
                <td className="num">{c ? formatCents(c.components.find((k) => k.key === "revenue")!.actualCents) : "…"}</td>
                <td className="num">{c ? <>{formatCents(c.planned.marginCents)} <span className="muted" style={{ fontSize: 12 }}>{c.planned.marginBasisPoints !== null && formatPercent(c.planned.marginBasisPoints)}</span></> : "…"}</td>
                <td className="num">{c ? <>{formatCents(c.actual.marginCents)} <span className="muted" style={{ fontSize: 12 }}>{c.actual.marginBasisPoints !== null && formatPercent(c.actual.marginBasisPoints)}</span></> : "…"}</td>
                <td className="num">{c ? <Deviation cents={c.deviationCents} /> : "…"}</td>
                <td>{c && (c.missing.length ? <span className="badge yellow" title={c.missing.join(", ")}>onvolledig</span> : c.complete ? <span className="badge green">afgerekend</span> : <span className="badge">lopend</span>)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
