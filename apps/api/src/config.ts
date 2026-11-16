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
  /** Afzender, bv. "Gecko <noreply@mail.gecko.nl>". Standaard noreply@MAILGUN_DOMAIN. */
  MAIL_FROM: z.string().optional(),
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
