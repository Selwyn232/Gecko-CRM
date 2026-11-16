import type { Config } from "../../config.js";

export interface CreatePaymentInput {
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  metadata: Record<string, string>;
}

export type ProviderStatus = "pending" | "paid" | "failed" | "expired" | "canceled";

/** Betaalprovider (Mollie of test). Verwisselbaar zonder de facturatie te raken. */
export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput, localPaymentId: string): Promise<{ providerPaymentId: string; checkoutUrl: string }>;
  /** Actuele status ophalen. Webhooks bevatten alleen een id; de status halen we altijd zelf op. */
  getStatus(providerPaymentId: string): Promise<{ status: ProviderStatus; amountCents: number; paidAt: Date | null } | null>;
}

const toMollieAmount = (cents: number) => (cents / 100).toFixed(2);

export class MollieProvider implements PaymentProvider {
  readonly name = "mollie";
  constructor(private readonly apiKey: string) {}

  private async call(path: string, init?: RequestInit) {
    const res = await fetch(`https://api.mollie.com/v2${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Mollie ${res.status}: ${String(data.detail ?? data.title ?? "onbekende fout")}`);
    return data;
  }

  async createPayment(input: CreatePaymentInput) {
    const data = (await this.call("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount: { currency: "EUR", value: toMollieAmount(input.amountCents) },
        description: input.description,
        redirectUrl: input.redirectUrl,
        webhookUrl: input.webhookUrl,
        metadata: input.metadata,
        locale: "nl_NL",
      }),
    })) as { id: string; _links: { checkout: { href: string } } };
    return { providerPaymentId: data.id, checkoutUrl: data._links.checkout.href };
  }

  async getStatus(providerPaymentId: string) {
    const data = (await this.call(`/payments/${encodeURIComponent(providerPaymentId)}`)) as {
      status: string;
      amount: { value: string };
      paidAt?: string;
    };
    const map: Record<string, ProviderStatus> = { paid: "paid", failed: "failed", expired: "expired", canceled: "canceled" };
    return {
      status: map[data.status] ?? "pending",
      amountCents: Math.round(Number(data.amount.value) * 100),
      paidAt: data.paidAt ? new Date(data.paidAt) : null,
    };
  }
}

/**
 * Testmodus: een gesimuleerde betaalpagina in het CRM zelf (/testbetaling/:id), waar je
 * "geslaagd" of "mislukt" kiest. De status wordt in de payments-tabel bijgehouden.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = "test";
  constructor(private readonly baseUrl: string) {}
  async createPayment(_input: CreatePaymentInput, localPaymentId: string) {
    return { providerPaymentId: `test_${localPaymentId}`, checkoutUrl: `${this.baseUrl}/testbetaling/${localPaymentId}` };
  }
  async getStatus() {
    return null; // status staat al in de eigen database
  }
}

export function paymentProviderFromConfig(config: Config): PaymentProvider {
  const base = config.APP_BASE_URL.replace(/\/$/, "");
  return config.MOLLIE_API_KEY ? new MollieProvider(config.MOLLIE_API_KEY) : new TestPaymentProvider(base);
}
