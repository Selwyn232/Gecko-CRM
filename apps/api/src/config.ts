import { z } from "zod";

/**
 * Alle configuratie komt uit omgevingsvariabelen en wordt bij het opstarten gevalideerd.
 * Ontbreekt er iets, dan start de applicatie niet — liever direct falen dan halverwege.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY moet 32 bytes base64 zijn"),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(720),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(168),
  APP_NAME: z.string().default("Gecko CRM"),
  /** Beperkt inlogpogingen per IP. Alleen uitzetten in tests. */
  /**
   * Aantal vertrouwde proxy's vóór de app. Bepaalt welk IP uit X-Forwarded-For wordt gebruikt.
   * Leeg = alles vertrouwen (oud gedrag; IP is dan te vervalsen). Instellen zodra het aantal hops bij Render is gecontroleerd.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Publieke basis-URL van het CRM, voor links in e-mails (zonder / aan het eind). */
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  /** Mailgun. Zonder sleutel wordt er niets verstuurd: e-mails worden alleen vastgelegd. */
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  MAILGUN_REGION: z.enum(["eu", "us"]).default("eu"),
  /** Mailgun "HTTP webhook signing key": nodig om binnenkomende e-mail (inbox) te accepteren. Leeg = inbox uit. */
  MAILGUN_WEBHOOK_SIGNING_KEY: z.string().optional(),
  /** Afzender, bv. "Gecko <noreply@mail.gecko.nl>". Standaard noreply@MAILGUN_DOMAIN. */
  MAIL_FROM: z.string().optional(),
  /** Antwoordadres dat iemand leest, bv. klantenservice@gecko.nl. Verbetert ook de bezorging. */
  MAIL_REPLY_TO: z.string().email().optional(),
  /** Mollie. Zonder sleutel draait betalen in testmodus (gesimuleerde betaalpagina). */
  MOLLIE_API_KEY: z.string().optional(),
  /** Sms (2FA) via CM.com: product token uit het CM.com-portaal. Zonder token is sms-2FA niet beschikbaar. */
  CM_PRODUCT_TOKEN: z.string().optional(),
  /** Afzender van de sms: max. 11 letters/cijfers. */
  SMS_SENDER: z.string().regex(/^[A-Za-z0-9]{1,11}$/, "SMS_SENDER: max. 11 letters/cijfers").default("Gecko"),
  /** Achtergrondtaken (automatiseringen, aanmaningen) draaien in dit proces. Uit in tests. */
  JOBS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Ongeldige configuratie:\n${issues}`);
  }
  return parsed.data;
}
