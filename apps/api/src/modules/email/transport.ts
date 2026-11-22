import type { Config } from "../../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Eigen afzendernaam, bv. "Ingrid de Wit | Gecko" (het adres blijft dat van MAIL_FROM). */
  fromName?: string | null;
}

/** "Naam <adres>" met een andere naam; het adres komt uit de standaardafzender. */
export function withFromName(from: string, name: string | null | undefined) {
  if (!name) return from;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  return `"${name.replace(/["\\<>\r\n]/g, "")}" <${address}>`;
}

/** Een manier om e-mail te versturen. Verwisselbaar (Mailgun, test, later eventueel een andere aanbieder). */
export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export class MailgunTransport implements EmailTransport {
  readonly name = "mailgun";
  constructor(
    private readonly apiKey: string,
    private readonly domain: string,
    private readonly region: "eu" | "us",
    private readonly from: string,
    private readonly replyTo?: string,
  ) {}

  async send(message: EmailMessage) {
    const host = this.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    const body = new FormData();
    body.set("from", withFromName(this.from, message.fromName));
    body.set("to", message.to);
    body.set("subject", message.subject);
    body.set("html", message.html);
    body.set("text", message.text);
    // Transactionele mail: geen klik-/open-tracking. Herschreven links en volgpixels verlagen de
    // betrouwbaarheid bij spamfilters (vooral Outlook) en zijn voor offertes/facturen niet nodig.
    body.set("o:tracking", "no");
    body.set("o:tracking-clicks", "no");
    body.set("o:tracking-opens", "no");
    if (this.replyTo) body.set("h:Reply-To", this.replyTo);
    const res = await fetch(`${host}/v3/${encodeURIComponent(this.domain)}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}` },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`Mailgun ${res.status}: ${data.message ?? "onbekende fout"}`);
    return { providerMessageId: data.id ?? "" };
  }
}

/** Kiest de transport op basis van de configuratie; null = niet versturen, alleen vastleggen. */
export function transportFromConfig(config: Config): EmailTransport | null {
  if (!config.MAILGUN_API_KEY || !config.MAILGUN_DOMAIN) return null;
  const from = config.MAIL_FROM ?? `Gecko <noreply@${config.MAILGUN_DOMAIN}>`;
  return new MailgunTransport(config.MAILGUN_API_KEY, config.MAILGUN_DOMAIN, config.MAILGUN_REGION, from, config.MAIL_REPLY_TO);
}

/** Voor tests: onthoudt verstuurde berichten. */
export class MemoryTransport implements EmailTransport {
  readonly name = "memory";
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return { providerMessageId: `mem-${this.sent.length}` };
  }
}
