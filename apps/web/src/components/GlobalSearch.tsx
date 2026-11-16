import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

interface Result { kind: string; label: string; detail: string; href: string }

/** Zoekbalk in de zijbalk: klant, postcode, telefoon, project-, offerte- en factuurnummer. Toets "/" om te zoeken. */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const results = useQuery({ queryKey: ["search", debounced], queryFn: () => api.get<Result[]>(`/search?q=${encodeURIComponent(debounced)}`), enabled: debounced.length >= 2 });
  const list = results.data ?? [];
  const go = (r: Result) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    navigate(r.href);
  };
  return (
    <div className="search">
      <input
        ref={input}
        type="search"
        placeholder="Zoeken…  ( / )"
        aria-label="Zoeken"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === "Enter" && list[active]) go(list[active]);
          if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
        }}
      />
      {open && debounced.length >= 2 && (
        <div className="search-results" role="listbox">
          {results.isLoading ? <div className="muted" style={{ padding: 10 }}>Zoeken…</div> : !list.length ? (
            <div className="muted" style={{ padding: 10 }}>Niets gevonden. Zoek op naam, e-mail, telefoon, postcode, adres of een nummer (K-, P-, O-, F…).</div>
          ) : (
            list.map((r, i) => (
              <button key={r.href} type="button" role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); go(r); }}>
                <span className="badge">{r.kind}</span> <strong>{r.label}</strong>
                <div className="muted" style={{ fontSize: 12 }}>{r.detail}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
