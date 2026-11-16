import { and, desc, eq, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { outboundEmails } from "./schema.js";
import type { EmailMessage, EmailTransport } from "./transport.js";

export interface SendEmailInput extends EmailMessage {
  template: string;
  customerId?: string | null;
  related?: { type: string; id: string };
}

/** Uitkomst van elke verzending in de serverlogs (zonder inhoud of ontvanger), voor diagnose. */
function logEmail(level: "info" | "error", data: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({ level: level === "error" ? 50 : 30, time: Date.now(), msg: "email", ...data });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Legt de e-mail vast en verstuurt hem (als er een transport is ingesteld).
 * Een mislukte verzending gooit geen fout naar de gebruiker; de status wordt "failed" met de reden.
 */
export async function sendEmail(db: DbOrTx, transport: EmailTransport | null, input: SendEmailInput) {
  const [row] = await db
    .insert(outboundEmails)
    .values({
      toAddress: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      template: input.template,
      customerId: input.customerId ?? null,
      relatedType: input.related?.type ?? null,
      relatedId: input.related?.id ?? null,
      status: transport ? "queued" : "not_sent",
      provider: transport?.name ?? null,
    })
    .returning();
  if (!transport) return row!;
  try {
    const { providerMessageId } = await transport.send(input);
    logEmail("info", { emailId: row!.id, template: input.template, status: "sent", provider: transport.name, providerMessageId });
    const [sent] = await db
      .update(outboundEmails)
      .set({ status: "sent", providerMessageId, sentAt: new Date() })
      .where(eq(outboundEmails.id, row!.id))
      .returning();
    return sent!;
  } catch (err) {
    logEmail("error", { emailId: row!.id, template: input.template, status: "failed", provider: transport.name, error: err instanceof Error ? err.message : String(err) });
    const [failed] = await db
      .update(outboundEmails)
      .set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 1000) : String(err) })
      .where(eq(outboundEmails.id, row!.id))
      .returning();
    return failed!;
  }
}

export function listEmails(db: DbOrTx, q: { relatedType?: string; relatedId?: string; customerId?: string }) {
  const filters: SQL[] = [];
  if (q.customerId) filters.push(eq(outboundEmails.customerId, q.customerId));
  if (q.relatedType) filters.push(eq(outboundEmails.relatedType, q.relatedType));
  if (q.relatedId) filters.push(eq(outboundEmails.relatedId, q.relatedId));
  return db
    .select()
    .from(outboundEmails)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(outboundEmails.createdAt))
    .limit(100);
}
