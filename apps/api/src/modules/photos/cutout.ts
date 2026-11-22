/**
 * B88: professionele uitsnede van de selfie (haar, randen, schouders) via een Europese dienst:
 * Photoroom (Frankrijk) of remove.bg (Oostenrijk). De sleutel staat in Render (PHOTOROOM_API_KEY of
 * REMOVEBG_API_KEY). Zonder sleutel doet de browser de uitsnede zelf (minder mooi).
 * Er gaat alleen de foto heen, geen naam of andere gegevens.
 */
import { badRequest } from "../../lib/errors.js";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
export function setCutoutFetcher(f: Fetcher | null) {
  fetcher = f ?? ((url, init) => fetch(url, init));
}

export function cutoutProvider() {
  if (process.env.PHOTOROOM_API_KEY) return "photoroom" as const;
  if (process.env.REMOVEBG_API_KEY) return "removebg" as const;
  return null;
}

const form = (jpeg: Buffer, field: string, extra: Record<string, string>) => {
  const fd = new FormData();
  fd.append(field, new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "selfie.jpg");
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
};

async function png(res: Response, name: string) {
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw badRequest("cutout_failed", `${name} kon de foto niet bewerken (${res.status}). ${text}`.trim());
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Geeft een PNG met transparante achtergrond terug (zelfde afmetingen), plus of de belichting al is gedaan. */
export async function cutout(jpeg: Buffer): Promise<{ png: Buffer; provider: string; relit: boolean }> {
  const p = cutoutProvider();
  if (p === "photoroom") {
    const key = process.env.PHOTOROOM_API_KEY!;
    // Eerst de uitgebreide versie (uitsnede + studiobelichting); lukt die niet (plan), dan alleen de uitsnede.
    const edit = await fetcher("https://image-api.photoroom.com/v2/edit", {
      method: "POST",
      headers: { "x-api-key": key },
      body: form(jpeg, "imageFile", {
        removeBackground: "true",
        "background.color": "transparent",
        "lighting.mode": "ai.auto",
        outputSize: "originalImage",
        "export.format": "png",
      }),
    }).catch(() => null);
    if (edit?.ok) return { png: Buffer.from(await edit.arrayBuffer()), provider: "photoroom", relit: true };
    const seg = await fetcher("https://sdk.photoroom.com/v1/segment", { method: "POST", headers: { "x-api-key": key }, body: form(jpeg, "image_file", { format: "png", size: "full" }) });
    return { png: await png(seg, "Photoroom"), provider: "photoroom", relit: false };
  }
  if (p === "removebg") {
    const res = await fetcher("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": process.env.REMOVEBG_API_KEY! },
      body: form(jpeg, "image_file", { size: "auto", type: "person", format: "png" }),
    });
    return { png: await png(res, "remove.bg"), provider: "removebg", relit: false };
  }
  throw badRequest("cutout_unavailable", "Professionele uitsnede staat (nog) niet aan");
}
