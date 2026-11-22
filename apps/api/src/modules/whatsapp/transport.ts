import type { Config } from "../../config.js";

/** Een parameter in een sjabloon (tekst), plus optioneel een afbeelding als kop. */
export interface TemplateMessage {
  name: string;
  language: string;
  bodyParams: string[];
  headerImageUrl?: string | null;
}

export interface WhatsappTransport {
  readonly name: string;
  sendText(to: string, body: string): Promise<{ providerMessageId: string }>;
  sendTemplate(to: string, t: TemplateMessage): Promise<{ providerMessageId: string }>;
}

/**
 * Meta WhatsApp Cloud API (graph.facebook.com). Vereist een permanente toegangssleutel (systeemgebruiker) en het
 * id van het telefoonnummer uit WhatsApp Manager. Zie docs/14-whatsapp.md.
 */
export class MetaCloudTransport implements WhatsappTransport {
  readonly name = "meta";
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly apiVersion = "v21.0",
  ) {}

  private async post(payload: Record<string, unknown>) {
    const res = await fetch(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number; error_data?: { details?: string } } };
    if (!res.ok || !json.messages?.[0]?.id) {
      const e = json.error;
      throw new Error(`WhatsApp ${res.status}${e?.code ? ` (${e.code})` : ""}: ${e?.error_data?.details ?? e?.message ?? "onbekende fout"}`);
    }
    return { providerMessageId: json.messages[0].id };
  }

  sendText(to: string, body: string) {
    return this.post({ to, type: "text", text: { preview_url: true, body: body.slice(0, 4096) } });
  }

  sendTemplate(to: string, t: TemplateMessage) {
    const components: Record<string, unknown>[] = [];
    if (t.headerImageUrl) components.push({ type: "header", parameters: [{ type: "image", image: { link: t.headerImageUrl } }] });
    if (t.bodyParams.length) components.push({ type: "body", parameters: t.bodyParams.map((text) => ({ type: "text", text: text.slice(0, 1000) })) });
    return this.post({ to, type: "template", template: { name: t.name, language: { code: t.language }, components } });
  }
}

/** Voor tests: onthoudt wat er "verstuurd" is. */
export class MemoryWhatsappTransport implements WhatsappTransport {
  readonly name = "memory";
  readonly sent: { to: string; text?: string; template?: TemplateMessage }[] = [];
  private n = 0;
  failNext: string | null = null;
  private next() {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
    return { providerMessageId: `wamid.test.${++this.n}` };
  }
  async sendText(to: string, body: string) {
    const r = this.next();
    this.sent.push({ to, text: body });
    return r;
  }
  async sendTemplate(to: string, t: TemplateMessage) {
    const r = this.next();
    this.sent.push({ to, template: t });
    return r;
  }
}

export function whatsappTransportFromConfig(config: Config): WhatsappTransport | null {
  if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID) return null;
  return new MetaCloudTransport(config.WHATSAPP_TOKEN, config.WHATSAPP_PHONE_NUMBER_ID);
}
