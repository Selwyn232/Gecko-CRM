import type { Config } from "../../config.js";

/** Versturen van een sms (2FA-codes). Bewust minimaal: één bericht naar één nummer. */
export interface SmsTransport {
  readonly name: string;
  send(to: string, text: string, reference?: string): Promise<void>;
}

/**
 * CM.com (Breda) Business Messaging, JSON-API.
 * Nummer in internationaal formaat met 00 (de API accepteert ook +, 00 is het gedocumenteerde formaat).
 */
export class CmSmsTransport implements SmsTransport {
  readonly name = "cm";
  constructor(
    private readonly productToken: string,
    private readonly sender: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, text: string, reference?: string) {
    const number = to.startsWith("+") ? `00${to.slice(1)}` : to;
    const res = await this.fetchImpl("https://gw.cmtelecom.com/v1.0/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: {
          authentication: { producttoken: this.productToken },
          msg: [{ from: this.sender, to: [{ number }], body: { type: "auto", content: text }, reference: reference?.slice(0, 32) }],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`CM.com ${res.status}: ${detail.slice(0, 300)}`);
    }
  }
}

export function smsTransportFromConfig(config: Config): SmsTransport | null {
  return config.CM_PRODUCT_TOKEN ? new CmSmsTransport(config.CM_PRODUCT_TOKEN, config.SMS_SENDER) : null;
}

/** Voor tests: onthoudt verstuurde berichten. */
export class MemorySmsTransport implements SmsTransport {
  readonly name = "memory";
  readonly sent: { to: string; text: string }[] = [];
  fail = false;
  async send(to: string, text: string) {
    if (this.fail) throw new Error("versturen mislukt (test)");
    this.sent.push({ to, text });
  }
}
