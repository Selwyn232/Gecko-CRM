import type { Config } from "../../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
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
  ) {}

  async send(message: EmailMessage) {
    const host = this.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    const body = new FormData();
    body.set("from", this.from);
    body.set("to", message.to);
    body.set("subject", message.subject);
    body.set("html", message.html);
    body.set("text", message.text);
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
  return new MailgunTransport(config.MAILGUN_API_KEY, config.MAILGUN_DOMAIN, config.MAILGUN_REGION, from);
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
