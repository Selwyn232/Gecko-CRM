import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { id } from "../../db/columns.js";

/**
 * Klantportaal "Mijn Gecko": inloggen zonder wachtwoord via een eenmalige link per e-mail.
 * De klant is herkend aan het e-mailadres; alle klantrecords met dat adres horen bij de sessie.
 * Tokens worden alleen gehasht opgeslagen.
 */
export const portalLoginTokens = pgTable(
  "portal_login_tokens",
  {
    id: id(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("portal_login_tokens_email_idx").on(t.email)],
);

export const portalSessions = pgTable(
  "portal_sessions",
  {
    id: id(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("portal_sessions_email_idx").on(t.email)],
);
