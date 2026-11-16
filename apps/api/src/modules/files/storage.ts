import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { files } from "./schema.js";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Controleert de echte bestandsinhoud (magic bytes), niet alleen wat de client zegt. */
function sniff(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  return null;
}

export async function saveFile(
  db: DbOrTx,
  input: { ownerType: string; ownerId: string; filename: string; dataBase64: string; createdBy: string | null },
) {
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) throw badRequest("file_empty", "Leeg bestand");
  if (data.length > MAX_FILE_BYTES) throw badRequest("file_too_large", "Bestand is te groot (max 8 MB)");
  const contentType = sniff(data);
  if (!contentType || !ALLOWED.has(contentType)) throw badRequest("file_type", "Alleen JPG, PNG, WebP of PDF");
  const [row] = await db
    .insert(files)
    .values({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      filename: input.filename.replace(/[^\w.\- ]/g, "_").slice(0, 200),
      contentType,
      sizeBytes: data.length,
      data,
      createdBy: input.createdBy,
    })
    .returning({ id: files.id, filename: files.filename, contentType: files.contentType, sizeBytes: files.sizeBytes });
  return row!;
}

export async function loadFile(db: DbOrTx, id: string) {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  if (!row || !row.data) throw notFound("Bestand");
  return row;
}

export const listFiles = (db: DbOrTx, ownerType: string, ownerId: string) =>
  db
    .select({ id: files.id, filename: files.filename, contentType: files.contentType, sizeBytes: files.sizeBytes, createdAt: files.createdAt })
    .from(files)
    .where(and(eq(files.ownerType, ownerType), eq(files.ownerId, ownerId)))
    .orderBy(asc(files.createdAt));
