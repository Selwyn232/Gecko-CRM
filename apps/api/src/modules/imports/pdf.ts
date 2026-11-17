import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Eén stuk tekst op een PDF-pagina, met positie (punten, oorsprong linksonder). */
export interface PdfText {
  str: string;
  x: number;
  y: number;
}

/**
 * Leest de tekst van alle pagina's, met posities. Draait volledig lokaal (pdf.js van Mozilla),
 * zonder externe dienst. Alleen tekst wordt gelezen; er wordt niets weergegeven of uitgevoerd.
 */
export async function extractPdfText(data: Buffer): Promise<PdfText[][]> {
  const task = getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: PdfText[][] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const items: PdfText[] = [];
      for (const it of content.items) {
        if (!("str" in it) || !it.str.trim()) continue;
        items.push({ str: it.str.trim(), x: it.transform[4] as number, y: it.transform[5] as number });
      }
      pages.push(items);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
