import { useState, type ChangeEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorBox } from "./ui";

/**
 * Profielfoto in de huisstijl: elke selfie wordt op exact dezelfde manier bewerkt, op het toestel zelf
 * (geen externe dienst). Stappen: gezicht zoeken → bijsnijden met het gezicht op vaste plek en grootte →
 * achtergrond weg (AI-segmentatie) → vaste Gecko-achtergrond → licht en kleur gelijktrekken.
 */

const OUT = 640;
/** Gezichtshoogte als deel van de foto, en waar het midden van het gezicht komt. */
const FACE_HEIGHT = 0.4;
const FACE_X = 0.5;
const FACE_Y = 0.46;
/** Doel-helderheid (0–255) en maximale correcties. */
const TARGET_LUMA = 150;

type Vision = typeof import("@mediapipe/tasks-vision");
type Models = { face: import("@mediapipe/tasks-vision").FaceDetector; seg: import("@mediapipe/tasks-vision").ImageSegmenter };
let models: Promise<Models> | null = null;
/** Modellen eenmalig laden (alleen op dit scherm), allemaal van onze eigen server. */
function loadModels() {
  models ??= (async () => {
    const v: Vision = await import("@mediapipe/tasks-vision");
    const fileset = await v.FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const face = await v.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/models/face_short.tflite" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
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

async function toCanvas(file: File) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

export async function processSelfie(file: File): Promise<string> {
  const src = await toCanvas(file);
  const { face, seg } = await loadModels();
  const faces = face.detect(src).detections;
  if (!faces.length) throw new Error("Geen gezicht gevonden. Kijk recht in de camera, in goed licht, en probeer opnieuw.");
  if (faces.length > 1) throw new Error("Er staan meerdere gezichten op de foto. Maak een selfie waar alleen jij op staat.");
  const bb = faces[0]!.boundingBox!;
  if (bb.height < src.height * 0.1) throw new Error("Je staat te ver weg. Houd de telefoon iets dichterbij (hoofd en schouders in beeld).");
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

  // Vaste Gecko-achtergrond.
  const out = document.createElement("canvas");
  out.width = out.height = OUT;
  const oc = out.getContext("2d")!;
  const bg = oc.createRadialGradient(OUT * 0.5, OUT * 0.38, OUT * 0.05, OUT * 0.5, OUT * 0.5, OUT * 0.75);
  bg.addColorStop(0, "#fff3e3");
  bg.addColorStop(0.55, "#ffd8a8");
  bg.addColorStop(1, "#fbb46a");
  oc.fillStyle = bg;
  oc.fillRect(0, 0, OUT, OUT);
  oc.drawImage(person, 0, 0);
  return out.toDataURL("image/jpeg", 0.88);
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

/** Selfie maken en opslaan. Gebruikt als verplichte stap na het inloggen, en om later een nieuwe te maken. */
export function SelfieCapture({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await processSelfie(f));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
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
  return (
    <div className="selfie">
      <div className={`selfie-frame ${preview ? "has" : ""}`}>
        {preview ? <img src={preview} alt="Jouw profielfoto" /> : <span aria-hidden="true">🙂</span>}
        {busy && <div className="selfie-busy">Bezig…</div>}
      </div>
      <ErrorBox error={error} />
      {!preview ? (
        <>
          <ul className="selfie-tips">
            <li>Kijk recht in de camera, hoofd en schouders in beeld</li>
            <li>Goed licht van voren (niet met een raam achter je)</li>
            <li>Geen zonnebril of pet</li>
          </ul>
          <label className={`btn primary selfie-btn ${busy ? "disabled" : ""}`}>
            Selfie maken
            <input type="file" accept="image/*" capture="user" onChange={(e) => void pick(e)} disabled={busy} hidden />
          </label>
          <label className="link-btn" style={{ display: "inline-block", marginTop: 8 }}>
            of kies een foto
            <input type="file" accept="image/*" onChange={(e) => void pick(e)} disabled={busy} hidden />
          </label>
        </>
      ) : (
        <div className="row" style={{ justifyContent: "center", gap: 8 }}>
          <button className="btn" disabled={busy} onClick={() => setPreview(null)}>Opnieuw</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>Deze foto gebruiken</button>
        </div>
      )}
      {onCancel && <button className="link-btn" style={{ marginTop: 12 }} onClick={onCancel}>Annuleren</button>}
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
          Iedereen bij Gecko heeft een herkenbare foto, in dezelfde stijl. Klanten en collega's zien zo met wie ze te maken hebben. De foto wordt op je eigen toestel bewerkt; er gaat niets naar een externe dienst.
        </p>
        <SelfieCapture onSaved={() => void refresh()} />
        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          Ingelogd als {me?.name}. <button className="link-btn" onClick={logout}>Uitloggen</button>
        </p>
      </div>
    </div>
  );
}
