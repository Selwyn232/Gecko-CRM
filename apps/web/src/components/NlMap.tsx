import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Loading } from "./ui";

interface Feature {
  properties: { code: string; name: string; from: number; to: number };
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}
interface Collection {
  attribution: string;
  features: Feature[];
}

/** Eenvoudige projectie voor Nederland: lengtegraad gecorrigeerd voor de breedtegraad (~52°). */
const K = 1000;
const COS = Math.cos((52.2 * Math.PI) / 180);
const px = (lon: number) => lon * COS * K;
const py = (lat: number) => -lat * K;

function toPath(coords: number[][][][]) {
  return coords
    .map((poly) => poly.map((ring) => `M${ring.map(([x, y]) => `${px(x!).toFixed(1)},${py(y!).toFixed(1)}`).join("L")}Z`).join(""))
    .join("");
}

/**
 * Klikbare kaart van Nederland met 200 gebieden. Klik om een gebied aan/uit te zetten,
 * of houd ingedrukt en sleep over gebieden om er meerdere tegelijk te kiezen.
 * Slepen vanaf zee/buiten de gebieden verschuift de kaart; scrollen of +/− zoomt.
 */
export function NlMap({ selected, onToggle, disabled }: { selected: Set<string>; onToggle: (code: string, on: boolean) => void; disabled?: boolean }) {
  const data = useQuery({ queryKey: ["nl-gebieden"], queryFn: async () => (await fetch("/nl-gebieden.geojson")).json() as Promise<Collection>, staleTime: Infinity });
  const shapes = useMemo(() => (data.data?.features ?? []).map((f) => ({ ...f.properties, d: toPath(f.geometry.coordinates) })), [data.data]);
  const full = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of data.data?.features ?? [])
      for (const poly of f.geometry.coordinates) for (const [x, y] of poly[0]!) {
        minX = Math.min(minX, px(x!)); maxX = Math.max(maxX, px(x!)); minY = Math.min(minY, py(y!)); maxY = Math.max(maxY, py(y!));
      }
    return { x: minX - 10, y: minY - 10, w: maxX - minX + 20, h: maxY - minY + 20 };
  }, [data.data]);
  const [view, setView] = useState<typeof full | null>(null);
  const v = view ?? full;
  const [hover, setHover] = useState<string | null>(null);
  const paint = useRef<{ on: boolean } | null>(null);
  const pan = useRef<{ x: number; y: number; v: typeof full } | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  if (data.isLoading || !data.data) return <Loading />;

  const zoom = (factor: number, cx = v.x + v.w / 2, cy = v.y + v.h / 2) => {
    const w = Math.min(full.w, Math.max(full.w / 12, v.w * factor));
    const h = (w / v.w) * v.h;
    setView({ x: cx - ((cx - v.x) * w) / v.w, y: cy - ((cy - v.y) * h) / v.h, w, h });
  };
  const toSvg = (e: React.PointerEvent | React.WheelEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: v.x + ((e.clientX - r.left) / r.width) * v.w, y: v.y + ((e.clientY - r.top) / r.height) * v.h };
  };

  const startArea = (e: React.PointerEvent, code: string) => {
    if (disabled) return;
    e.stopPropagation();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    const on = !selected.has(code);
    paint.current = { on };
    onToggle(code, on);
  };
  const enterArea = (code: string) => {
    setHover(code);
    if (paint.current && selected.has(code) !== paint.current.on) onToggle(code, paint.current.on);
  };
  const hovered = shapes.find((s) => s.code === hover);

  return (
    <div className="nlmap">
      <svg
        ref={svg}
        viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={(e) => { pan.current = { x: e.clientX, y: e.clientY, v }; svg.current!.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (!pan.current || paint.current) return;
          const r = svg.current!.getBoundingClientRect();
          const dx = ((e.clientX - pan.current.x) / r.width) * pan.current.v.w;
          const dy = ((e.clientY - pan.current.y) / r.height) * pan.current.v.h;
          setView({ ...pan.current.v, x: pan.current.v.x - dx, y: pan.current.v.y - dy });
        }}
        onPointerUp={() => { paint.current = null; pan.current = null; }}
        onPointerLeave={() => { paint.current = null; pan.current = null; setHover(null); }}
        onWheel={(e) => { const p = toSvg(e); zoom(e.deltaY > 0 ? 1.25 : 0.8, p.x, p.y); }}
        style={{ touchAction: "none" }}
      >
        {shapes.map((s) => (
          <path
            key={s.code}
            d={s.d}
            className={`nlmap-area ${selected.has(s.code) ? "on" : ""} ${hover === s.code ? "hover" : ""}`}
            onPointerDown={(e) => startArea(e, s.code)}
            onPointerEnter={() => enterArea(s.code)}
            onPointerLeave={() => setHover((h) => (h === s.code ? null : h))}
          >
            <title>{s.name}</title>
          </path>
        ))}
      </svg>
      <div className="nlmap-controls">
        <button type="button" className="btn small" onClick={() => zoom(0.7)} aria-label="Inzoomen">+</button>
        <button type="button" className="btn small" onClick={() => zoom(1.4)} aria-label="Uitzoomen">−</button>
        <button type="button" className="btn small" onClick={() => setView(null)}>Heel NL</button>
      </div>
      <div className="nlmap-info">{hovered ? <><strong>{hovered.name}</strong>{selected.has(hovered.code) ? " · in werkgebied" : ""}</> : <span className="muted">Wijs een gebied aan</span>}</div>
      <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{data.data.attribution}</div>
    </div>
  );
}

export function useMapAreas() {
  return useQuery({
    queryKey: ["nl-gebieden"],
    queryFn: async () => (await fetch("/nl-gebieden.geojson")).json() as Promise<Collection>,
    staleTime: Infinity,
  });
}
