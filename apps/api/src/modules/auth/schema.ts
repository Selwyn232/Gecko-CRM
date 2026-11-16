import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { advisors, organizations } from "../organizations/schema.js";

export const users = pgTable(
  "users",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Altijd opgeslagen in kleine letters. E-mail of gebruikersnaam (minstens één) is de inlognaam. */
    email: text("email"),
    username: text("username"),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /** Versleuteld met ENCRYPTION_KEY. Gevuld zodra 2FA-instelling start; actief vanaf totpEnabledAt. */
    totpSecretEncrypted: text("totp_secret_encrypted"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** Laatst gebruikte TOTP-stap; voorkomt dat één code twee keer werkt. */
    totpLastStep: integer("totp_last_step"),
    /** Of 2FA verplicht is voor deze gebruiker. Standaard ja; uitzonderingen zijn een bewuste keuze van een beheerder. */
    mfaRequired: boolean("mfa_required").notNull().default(true),
    /** Gebruiker moet eerst een eigen wachtwoord kiezen voordat het systeem bruikbaar is. */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Gebruiker van een verkooppartner die één adviseur is: ziet dan alleen de eigen offertes. */
    advisorId: uuid("advisor_id").references(() => advisors.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_unique").on(sql`lower(${t.username})`),
    check("users_login_present", sql`${t.email} IS NOT NULL OR ${t.username} IS NOT NULL`),
    index("users_organization_idx").on(t.organizationId),
  ],
);

export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Alleen de hash van het token staat in de database; een gelekte database levert geen sessies op. */
    tokenHash: text("token_hash").notNull().unique(),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    /** Gevuld als een beheerder via "Inloggen als" in dit account kijkt. */
    impersonatorUserId: uuid("impersonator_user_id").references(() => users.id),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Rollen zijn door beheerders in te stellen. Rechten zelf staan vast in code (zie permissions.ts). */
export const roles = pgTable("roles", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** Systeemrollen (zoals beheerder) kunnen niet worden verwijderd. */
  isSystem: boolean("is_system").notNull().default(false),
  ...timestamps(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index("user_roles_role_idx").on(t.roleId)],
);

export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;

/**
 * API-sleutels voor koppelingen (bv. Greenteam). Een sleutel hoort bij een gebruiker en heeft precies diens rechten;
 * gebruik daarom een aparte koppelgebruiker. Alleen de hash wordt bewaard; de sleutel is één keer zichtbaar.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** Eerste tekens van de sleutel, om hem te herkennen. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);
