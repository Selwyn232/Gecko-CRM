import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox, Loading } from "../components/ui";

interface WorkSection {
  key: string;
  title: string;
  hint: string;
  severity: "high" | "normal";
  count: number;
  items: { label: string; detail?: string; href: string; date?: string | null }[];
  href: string;
}

/** Startpagina: wat vandaag aandacht nodig heeft, volgens de rechten van de gebruiker. */
export function WorkPage() {
  const { me } = useAuth();
  const work = useQuery({ queryKey: ["work"], queryFn: () => api.get<{ sections: WorkSection[] }>("/work"), refetchInterval: 60_000 });
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Goedemorgen" : hour < 18 ? "Goedemiddag" : "Goedenavond";
  if (work.isLoading) return <Loading />;
  if (!work.data) return <ErrorBox error={work.error} />;
  const sections = [...work.data.sections].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
  const total = sections.reduce((n, s) => n + s.count, 0);
  const urgent = sections.filter((s) => s.severity === "high").length;
  return (
    <>
      <div className="hello-card">
        <div>
          <h1>{greet}{me?.name ? ` ${me.name.split(" ")[0]}` : ""}</h1>
          <p>
            {!sections.length
              ? "Alles is bij. Geniet van je dag."
              : `${urgent ? `${urgent} ${urgent === 1 ? "onderwerp vraagt" : "onderwerpen vragen"} vandaag om aandacht` : "Niets dringends"}, ${total} ${total === 1 ? "punt staat" : "punten staan"} open.`}
          </p>
        </div>
        <img src="/gecko-logo-192.png" alt="" />
      </div>
      {!sections.length ? (
        <div className="card empty">Er staat niets open dat aandacht nodig heeft. 🎉</div>
      ) : (
        <div className="work-grid">
          {sections.map((s) => (
            <div key={s.key} className={`card flush work-card${s.severity === "high" ? " high" : ""}`}>
              <div className="row" style={{ justifyContent: "space-between", padding: "14px 16px 4px", flexWrap: "nowrap" }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>{s.title}</h2>
                <span className={`badge ${s.severity === "high" ? "red" : ""}`}>{s.count}</span>
              </div>
              <p className="muted" style={{ margin: "0 16px 8px", fontSize: 12 }}>{s.hint}</p>
              <ul className="work-list">
                {s.items.map((i, n) => (
                  <li key={n}>
                    <Link to={i.href}>{i.label}</Link>
                    {i.detail && <div className="muted" style={{ fontSize: 12 }}>{i.detail}</div>}
                  </li>
                ))}
              </ul>
              {s.count > s.items.length && <Link className="work-more" to={s.href}>Alle {s.count} bekijken →</Link>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
