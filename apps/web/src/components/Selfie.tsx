import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox } from "./ui";

/**
 * Profielfoto in de huisstijl (B88): een echte selfie met de live camera (geen upload), met een ovaal in beeld
 * waar het hoofd in moet, en een echtheidscheck (knipperen met de ogen: een foto of scherm kan dat niet).
 * Daarna wordt elke foto op exact dezelfde manier bewerkt, op het toestel zelf (geen externe dienst):
 * gezicht op vaste plek en grootte → achtergrond weg (AI-segmentatie) → vaste Gecko-achtergrond →
 * licht en huidtint gelijktrekken.
 */

const OUT = 640;
/** Gezichtshoogte als deel van de foto, en waar het midden van het gezicht komt. */
const FACE_HEIGHT = 0.36;
const FACE_X = 0.5;
const FACE_Y = 0.42;
/** Doel-helderheid (0–255) en maximale correcties. */
const TARGET_LUMA = 150;

/** Ovaal in het camerabeeld (als deel van de beeldbreedte/-hoogte van de zoeker, 3:4). */
const GUIDE = { cx: 0.5, cy: 0.44, w: 0.56, h: 0.56 };

type Vision = typeof import("@mediapipe/tasks-vision");
type Landmarker = import("@mediapipe/tasks-vision").FaceLandmarker;
type Models = { face: Landmarker; seg: import("@mediapipe/tasks-vision").ImageSegmenter };
let models: Promise<Models> | null = null;
/** Modellen eenmalig laden (alleen op dit scherm), allemaal van onze eigen server. */
function loadModels() {
  models ??= (async () => {
    const v: Vision = await import("@mediapipe/tasks-vision");
    const fileset = await v.FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const face = await v.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/models/face_landmarker.task" },
      runningMode: "VIDEO",
      numFaces: 2,
      outputFaceBlendshapes: true,
    });
    const seg = await v.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/models/selfie_segmenter.tflite" },
      runningMode: "IMAGE",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    return { face, seg };
  })().catch((err) => {
    models = null;
    throw err instanceof Error ? err : new Error("De fotobewerking kon niet worden geladen. Probeer het opnieuw.");
  });
  return models;
}

type Box = { originX: number; originY: number; width: number; height: number };
/** Kader om het gezicht uit de gezichtspunten (genormaliseerd 0–1 → pixels). */
function landmarkBox(points: { x: number; y: number }[], w: number, h: number): Box {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { originX: x0 * w, originY: y0 * h, width: (x1 - x0) * w, height: (y1 - y0) * h };
}

/** Bewerkt een vastgelegd camerabeeld (canvas) met het gezichtskader tot de profielfoto in huisstijl. */
/** Vaste Gecko-achtergrond met daarop de vrijstaande persoon. */
function compose(person: HTMLCanvasElement) {
  const out = document.createElement("canvas");
  out.width = out.height = OUT;
  const oc = out.getContext("2d")!;
  const bg = oc.createRadialGradient(OUT * 0.5, OUT * 0.38, OUT * 0.05, OUT * 0.5, OUT * 0.5, OUT * 0.75);
  bg.addColorStop(0, "#fff3e3");
  bg.addColorStop(0.55, "#ffd8a8");
  bg.addColorStop(1, "#fbb46a");
  oc.fillStyle = bg;
  oc.fillRect(0, 0, OUT, OUT);
  oc.drawImage(person, 0, 0, OUT, OUT);
  return out.toDataURL("image/jpeg", 0.9);
}

let cutoutProvider: Promise<string | null> | null = null;
/** Professionele uitsnede via de server (Photoroom of remove.bg), als die aan staat. */
async function professionalCutout(src: HTMLCanvasElement, bb: Box): Promise<string | null> {
  cutoutProvider ??= api.get<{ provider: string | null }>("/auth/me/photo/cutout").then((r) => r.provider).catch(() => null);
  if (!(await cutoutProvider)) return null;
  // Portretuitsnede (hoofd en schouders) op hoge resolutie, met het gezicht al op de vaste plek.
  const SIZE = 1024;
  const scale = (SIZE * FACE_HEIGHT) / bb.height;
  const crop = document.createElement("canvas");
  crop.width = crop.height = SIZE;
  const cc = crop.getContext("2d")!;
  cc.fillStyle = "#808080";
  cc.fillRect(0, 0, SIZE, SIZE);
  cc.setTransform(scale, 0, 0, scale, SIZE * FACE_X - (bb.originX + bb.width / 2) * scale, SIZE * FACE_Y - (bb.originY + bb.height / 2) * scale);
  cc.drawImage(src, 0, 0, src.width, src.height);
  const r = await api.post<{ dataUrl: string; relit: boolean }>("/auth/me/photo/cutout", { dataUrl: crop.toDataURL("image/jpeg", 0.92) });
  const img = new Image();
  img.src = r.dataUrl;
  await img.decode();
  const person = document.createElement("canvas");
  person.width = person.height = OUT;
  const pc = person.getContext("2d", { willReadFrequently: true })!;
  pc.drawImage(img, 0, 0, OUT, OUT);
  // Belichting: bij Photoroom met studiobelichting niets meer doen; anders onze licht- en kleurcorrectie.
  if (!r.relit) normalize(pc, pc, { x: OUT * FACE_X, y: OUT * FACE_Y, r: (OUT * FACE_HEIGHT) / 2 });
  return compose(person);
}

export async function processSelfie(src: HTMLCanvasElement, bb: Box): Promise<string> {
  try {
    const pro = await professionalCutout(src, bb);
    if (pro) return pro;
  } catch {
    /* dienst niet bereikbaar: dan de uitsnede op het toestel */
  }
  const { seg } = await loadModels();
  // Achtergrond: kans per pixel dat het de persoon is.
  const res = seg.segment(src);
  const cm = res.confidenceMasks ?? [];
  const m0 = cm[0];
  if (!m0) throw new Error("De achtergrond kon niet worden bepaald. Probeer het opnieuw.");
  const probs = m0.getAsFloat32Array();
  const personProb = cm.length > 1 ? (i: number) => 1 - probs[i]! : (i: number) => probs[i]!;
  const maskSrc = document.createElement("canvas");
  maskSrc.width = m0.width;
  maskSrc.height = m0.height;
  const msc = maskSrc.getContext("2d")!;
  const md = msc.createImageData(m0.width, m0.height);
  for (let i = 0; i < probs.length; i++) {
    const a = Math.max(0, Math.min(1, (personProb(i) - 0.25) / 0.5)); // zachte rand
    md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255;
    md.data[i * 4 + 3] = Math.round(a * 255);
  }
  keepFaceRegion(md, (bb.originX + bb.width / 2) * (m0.width / src.width), (bb.originY + bb.height / 2) * (m0.height / src.height));
  msc.putImageData(md, 0, 0);
  for (const mask of cm) mask.close();

  // Vaste uitsnede: gezicht altijd even groot en op dezelfde plek.
  const scale = (OUT * FACE_HEIGHT) / bb.height;
  const cx = bb.originX + bb.width / 2;
  const cy = bb.originY + bb.height / 2;
  const tx = OUT * FACE_X - cx * scale;
  const ty = OUT * FACE_Y - cy * scale;
  const place = (ctx: CanvasRenderingContext2D, img: CanvasImageSource) => {
    ctx.setTransform(scale, 0, 0, scale, tx, ty);
    ctx.drawImage(img, 0, 0, src.width, src.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  // Persoon, met licht en kleur gelijkgetrokken.
  const person = document.createElement("canvas");
  person.width = person.height = OUT;
  const pc = person.getContext("2d", { willReadFrequently: true })!;
  place(pc, src);
  const mask = document.createElement("canvas");
  mask.width = mask.height = OUT;
  const mc = mask.getContext("2d", { willReadFrequently: true })!;
  mc.filter = "blur(1.5px)";
  place(mc, maskSrc);
  mc.filter = "none";
  normalize(pc, mc, { x: OUT * FACE_X, y: OUT * FACE_Y, r: (OUT * FACE_HEIGHT) / 2 });
  pc.globalCompositeOperation = "destination-in";
  pc.drawImage(mask, 0, 0);
  return compose(person);
}

/** Alleen de persoon bij het gevonden gezicht houden (mensen naast je vallen weg). */
function keepFaceRegion(md: ImageData, fx: number, fy: number) {
  const { width: w, height: h, data } = md;
  const seen = new Uint8Array(w * h);
  const start = Math.round(fy) * w + Math.round(fx);
  if (start < 0 || start >= w * h) return;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (seen[q] || data[q * 4 + 3]! < 90) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  // Pixels die niet aan het gezicht vastzitten: weg (een smalle zoom blijft voor een zachte rand).
  for (let i = 0; i < w * h; i++) if (!seen[i] && data[i * 4 + 3]! >= 90) data[i * 4 + 3] = 0;
}

/** Helderheid naar een vast niveau (gemeten op het gezicht), milde witbalans, iets warmer en meer contrast. */
function normalize(pc: CanvasRenderingContext2D, mc: CanvasRenderingContext2D, faceArea: { x: number; y: number; r: number }) {
  const img = pc.getImageData(0, 0, OUT, OUT);
  const m = mc.getImageData(0, 0, OUT, OUT).data;
  const d = img.data;
  let sr = 0, sg = 0, sb = 0, sl = 0, n = 0, fl = 0, fn = 0, fr = 0, fg = 0, fb = 0;
  for (let y = 0; y < OUT; y += 2) {
    for (let x = 0; x < OUT; x += 2) {
      const i = (y * OUT + x) * 4;
      if (m[i + 3]! < 128) continue;
      const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      sr += d[i]!; sg += d[i + 1]!; sb += d[i + 2]!; sl += l; n++;
      if ((x - faceArea.x) ** 2 + (y - faceArea.y) ** 2 < (faceArea.r * 0.7) ** 2) { fl += l; fn++; fr += d[i]!; fg += d[i + 1]!; fb += d[i + 2]!; }
    }
  }
  if (!n) return;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // Witbalans op de huid: typische huidtint heeft r/g ≈ 1,25 en b/g ≈ 0,85. Voor 60% die kant op, hooguit 15%.
  const ar = fn ? fr / fn : sr / n, ag = fn ? fg / fn : sg / n, ab = fn ? fb / fn : sb / n;
  const kr = clamp(1 + 0.6 * ((1.25 * ag) / ar - 1), 0.85, 1.15);
  const kg = 1;
  const kb = clamp(1 + 0.6 * ((0.85 * ag) / ab - 1), 0.85, 1.15);
  if (fn && fl / fn < 45) throw new Error("Te donker. Zoek meer licht (bij voorkeur van voren) en probeer opnieuw.");
  const gain = clamp(TARGET_LUMA / ((fn ? fl / fn : sl / n) || 1), 0.75, 1.6);
  const curve = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    curve[v] = 255 * (t + 0.12 * (t - 0.5) * (1 - Math.abs(2 * t - 1))); // licht S-curve (contrast)
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = curve[Math.min(255, Math.round(d[i]! * gain * kr))]!;
    d[i + 1] = curve[Math.min(255, Math.round(d[i + 1]! * gain * kg))]!;
    d[i + 2] = curve[Math.min(255, Math.round(d[i + 2]! * gain * kb))]!;
  }
  pc.putImageData(img, 0, 0);
}

type Hint = { ok: boolean; text: string };

/**
 * Live camera met ovaal: het hoofd moet in het ovaal, recht, op de juiste afstand. Pas als je met je ogen hebt
 * geknipperd (echtheidscheck) en even stil houdt, wordt de foto automatisch gemaakt.
 */
export function SelfieCapture({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<"loading" | "live" | "processing" | "preview" | "nocamera">("loading");
  const [hint, setHint] = useState<Hint>({ ok: false, text: "Camera starten…" });
  const [blinked, setBlinked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (phase === "preview" || phase === "nocamera") return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    let eyesClosed = false;
    let blink = false;
    let steadySince = 0;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("no camera", "NotFoundError");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        const { face } = await loadModels();
        if (stopped) return;
        setPhase("live");
        const loop = () => {
          if (stopped) return;
          if (video.readyState >= 2) {
            const r = face.detectForVideo(video, performance.now());
            const vw = video.videoWidth, vh = video.videoHeight;
            const faces = r.faceLandmarks ?? [];
            let h: Hint;
            if (!faces.length) h = { ok: false, text: "Plaats je hoofd in het ovaal" };
            else if (faces.length > 1) h = { ok: false, text: "Alleen jij in beeld, graag" };
            else {
              // Ovaal ligt in een 3:4-zoeker (object-fit: cover); reken het gezicht om naar zoekercoördinaten.
              const box = landmarkBox(faces[0]!, vw, vh);
              const viewW = Math.min(vw, (vh * 3) / 4), viewH = Math.min(vh, (vw * 4) / 3);
              const ox = (vw - viewW) / 2, oy = (vh - viewH) / 2;
              const fx = (box.originX + box.width / 2 - ox) / viewW;
              const fy = (box.originY + box.height / 2 - oy) / viewH;
              const fh = box.height / viewH;
              // Echtheidscheck: ogen dicht en weer open.
              const bs = r.faceBlendshapes?.[0]?.categories ?? [];
              const eye = (n: string) => bs.find((c) => c.categoryName === n)?.score ?? 0;
              const closed = eye("eyeBlinkLeft") > 0.5 && eye("eyeBlinkRight") > 0.5;
              if (closed) eyesClosed = true;
              else if (eyesClosed && eye("eyeBlinkLeft") < 0.25 && eye("eyeBlinkRight") < 0.25) {
                if (!blink) setBlinked(true);
                blink = true;
              }
              // Gespiegeld beeld: links/rechts voor de gebruiker omdraaien.
              const dx = 1 - fx - GUIDE.cx, dy = fy - GUIDE.cy;
              if (fh < GUIDE.h * 0.62) h = { ok: false, text: "Kom iets dichterbij" };
              else if (fh > GUIDE.h * 0.95) h = { ok: false, text: "Iets verder weg" };
              else if (dx < -0.07) h = { ok: false, text: "Schuif iets naar rechts" };
              else if (dx > 0.07) h = { ok: false, text: "Schuif iets naar links" };
              else if (dy < -0.07) h = { ok: false, text: "Iets lager" };
              else if (dy > 0.07) h = { ok: false, text: "Iets hoger" };
              else if (!blink) h = { ok: true, text: "Goed zo. Knipper nu met je ogen" };
              else h = { ok: true, text: "Stil houden…" };
              if (h.ok && blink && !closed) {
                steadySince ||= performance.now();
                if (performance.now() - steadySince > 900) {
                  stopped = true;
                  const c = document.createElement("canvas");
                  c.width = vw;
                  c.height = vh;
                  c.getContext("2d")!.drawImage(video, 0, 0, vw, vh);
                  setPhase("processing");
                  setHint({ ok: true, text: "Foto wordt bewerkt…" });
                  stream?.getTracks().forEach((t) => t.stop());
                  processSelfie(c, box)
                    .then((url) => {
                      setPreview(url);
                      setPhase("preview");
                    })
                    .catch((err) => {
                      setError(err);
                      setPhase("loading");
                      setAttempt((n) => n + 1);
                    });
                  return;
                }
              } else steadySince = 0;
            }
            setHint(h);
          }
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        if (stopped) return;
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError" || name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError") setPhase("nocamera");
        else setError(err);
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [attempt, phase === "preview" || phase === "nocamera"]);

  const retake = () => {
    setPreview(null);
    setBlinked(false);
    setError(null);
    setPhase("loading");
    setAttempt((n) => n + 1);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put("/auth/me/photo", { dataUrl: preview });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (phase === "nocamera") {
    return (
      <div className="selfie">
        <div className="alert warning" style={{ textAlign: "left" }}>
          <strong>Geen toegang tot de camera.</strong> Een profielfoto maak je met de camera van je toestel (een bestaande foto kiezen kan niet).
          <ul className="loc-help">
            <li><strong>iPhone / iPad:</strong> paginamenu links in de adresbalk → <em>Website-instellingen</em> → <em>Camera</em> → <em>Sta toe</em>.</li>
            <li><strong>Android (Chrome):</strong> icoon links van het adres → <em>Machtigingen</em> → <em>Camera</em> → <em>Toestaan</em>.</li>
            <li><strong>Computer zonder camera:</strong> log in op je telefoon en maak daar je selfie.</li>
          </ul>
        </div>
        <button className="btn primary" onClick={() => { setPhase("loading"); setAttempt((n) => n + 1); }}>Opnieuw proberen</button>
        {onCancel && <button className="link-btn" onClick={onCancel}>Annuleren</button>}
      </div>
    );
  }

  return (
    <div className="selfie">
      {phase === "preview" && preview ? (
        <div className="selfie-frame has"><img src={preview} alt="Jouw profielfoto" /></div>
      ) : (
        <div className={`selfie-cam ${hint.ok ? "ok" : ""}`}>
          <video ref={videoRef} playsInline muted autoPlay />
          <svg className="selfie-guide" viewBox="0 0 300 400" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <mask id="selfie-hole">
                <rect width="300" height="400" fill="white" />
                <ellipse cx={300 * GUIDE.cx} cy={400 * GUIDE.cy} rx={(300 * GUIDE.w) / 2} ry={(400 * GUIDE.h) / 2} fill="black" />
              </mask>
            </defs>
            <rect width="300" height="400" fill="rgba(0,0,0,0.45)" mask="url(#selfie-hole)" />
            <ellipse className="selfie-oval" cx={300 * GUIDE.cx} cy={400 * GUIDE.cy} rx={(300 * GUIDE.w) / 2} ry={(400 * GUIDE.h) / 2} />
            <line className="selfie-grid" x1="150" y1="0" x2="150" y2="400" />
            <line className="selfie-grid" x1="0" y1={400 * GUIDE.cy} x2="300" y2={400 * GUIDE.cy} />
          </svg>
          <div className="selfie-hint" role="status">{hint.text}</div>
          <div className={`selfie-check ${blinked ? "done" : ""}`}>{blinked ? "✓ Echtheid gecontroleerd" : "Echtheidscheck: knipper met je ogen"}</div>
        </div>
      )}
      <ErrorBox error={error} />
      {phase === "preview" ? (
        <div className="row" style={{ justifyContent: "center", gap: 8 }}>
          <button className="btn" disabled={busy} onClick={retake}>Opnieuw</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>Deze foto gebruiken</button>
        </div>
      ) : (
        <ul className="selfie-tips">
          <li>Hoofd in het ovaal, recht in de camera kijken</li>
          <li>Goed licht van voren, geen pet of zonnebril</li>
          <li>De foto wordt vanzelf gemaakt als alles klopt</li>
        </ul>
      )}
      {onCancel && <button className="link-btn" onClick={onCancel}>Annuleren</button>}
    </div>
  );
}

/** Verplichte stap (na inloggen) voor iedereen zonder profielfoto. */
export function SelfieRequired() {
  const { refresh, logout, me } = useAuth();
  return (
    <div className="auth-wrap">
      <div className="auth-card card" style={{ textAlign: "center" }}>
        <div className="brand" style={{ justifyContent: "center" }}>
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        <h2>Maak je profielfoto</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
          Iedereen bij Gecko heeft een herkenbare foto, in dezelfde stijl. Klanten en collega's zien zo met wie ze te maken hebben. Je maakt hem met de camera; de foto wordt op je eigen toestel bewerkt en er gaat niets naar een externe dienst.
        </p>
        <SelfieCapture onSaved={() => void refresh()} />
        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          Ingelogd als {me?.name}. <button className="link-btn" onClick={logout}>Uitloggen</button>
        </p>
      </div>
    </div>
  );
}
