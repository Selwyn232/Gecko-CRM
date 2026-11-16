import { useState } from "react";
import { api } from "../api";
import { ErrorBox } from "./ui";

/** Verkleint een foto in de browser (max 1600 px, JPEG) voordat hij wordt verstuurd: sneller en zuiniger met opslag. */
export async function resizeToJpegBase64(file: File, max = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82).split(",")[1]!;
}

export function PhotoUpload({ uploadUrl, onUploaded }: { uploadUrl: string; onUploaded: () => void }) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const upload = async (list: FileList | null) => {
    if (!list) return;
    setError(null);
    for (const f of Array.from(list)) {
      setBusy((n) => n + 1);
      try {
        const dataBase64 = f.type === "application/pdf" ? await toBase64(f) : await resizeToJpegBase64(f);
        await api.post(uploadUrl, { filename: f.name.replace(/\.\w+$/, f.type === "application/pdf" ? ".pdf" : ".jpg"), dataBase64 });
        onUploaded();
      } catch (e) {
        setError(e);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  return (
    <div>
      <ErrorBox error={error} />
      <label className="btn">
        📷 Foto's toevoegen
        <input type="file" accept="image/*,application/pdf" multiple capture="environment" style={{ display: "none" }} onChange={(e) => void upload(e.target.files)} />
      </label>
      {busy > 0 && <span className="muted" style={{ marginLeft: 8 }}>Uploaden… ({busy})</span>}
    </div>
  );
}

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]!);
    r.onerror = reject;
    r.readAsDataURL(f);
  });

export function PhotoGrid({ files }: { files: { id: string; filename: string; contentType: string }[] }) {
  if (!files.length) return <p className="muted">Nog geen foto's.</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
      {files.map((f) => (
        <a key={f.id} href={`/api/files/${f.id}`} target="_blank" rel="noreferrer">
          {f.contentType.startsWith("image/") ? (
            <img src={`/api/files/${f.id}`} alt={f.filename} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
          ) : (
            <div className="card" style={{ margin: 0, aspectRatio: "1", display: "grid", placeItems: "center", fontSize: 12 }}>{f.filename}</div>
          )}
        </a>
      ))}
    </div>
  );
}
