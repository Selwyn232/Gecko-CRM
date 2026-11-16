import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../../lib/crypto.js";
import { AppError, badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../../lib/totp.js";
import { recordAudit } from "../audit/service.js";
import { assertPasswordPolicy, getDummyHash, hashPassword, verifyPassword } from "./password.js";
import { recoveryCodes, sessions, users, type User } from "./schema.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;
/** last_seen_at wordt hooguit eens per minuut bijgewerkt, om schrijfacties te beperken. */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionInfo {
  sessionId: string;
  user: User;
  mfaVerified: boolean;
}

export type MfaState = "verify" | "setup";

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  /** Stap 1: e-mail + wachtwoord. Levert een sessie op die pas na 2FA volledig bruikbaar is. */
  async login(email: string, password: string, meta: { ip?: string; userAgent?: string; requestId?: string }) {
    const normalized = email.trim().toLowerCase();
    const [user] = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    const actor: ActorContext = {
      userId: user?.id ?? null,
      organizationId: user?.organizationId ?? null,
      permissions: new Set(),
      ip: meta.ip,
      requestId: meta.requestId,
    };

    if (!user) {
      await verifyPassword(await getDummyHash(), password);
      await recordAudit(this.db, actor, {
        action: "auth.login_failed",
        entityType: "user",
        metadata: { email: normalized, reason: "unknown_email" },
      });
      throw unauthorized("invalid_credentials", "E-mailadres of wachtwoord onjuist");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, "account_locked", "Account tijdelijk geblokkeerd na te veel mislukte pogingen");
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid || !user.isActive) {
      await this.registerFailure(user, actor, valid ? "inactive" : "wrong_password");
      throw unauthorized("invalid_credentials", "E-mailadres of wachtwoord onjuist");
    }

    const token = randomToken();
    const now = new Date();
    const [session] = await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
        .where(eq(users.id, user.id));
      await recordAudit(tx, actor, { action: "auth.login", entityType: "user", entityId: user.id });
      return tx
        .insert(sessions)
        .values({
          userId: user.id,
          tokenHash: sha256(token),
          ip: meta.ip,
          userAgent: meta.userAgent?.slice(0, 500),
          expiresAt: new Date(now.getTime() + this.config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600_000),
        })
        .returning();
    });

    const mfa: MfaState = user.totpEnabledAt ? "verify" : "setup";
    return { token, sessionId: session!.id, mfa };
  }

  private async registerFailure(user: User, actor: ActorContext, reason: string) {
    const count = user.failedLoginCount + 1;
    const lock = count >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: lock ? 0 : count, lockedUntil: lock ?? user.lockedUntil })
        .where(eq(users.id, user.id));
      await recordAudit(tx, actor, {
        action: lock ? "auth.account_locked" : "auth.login_failed",
        entityType: "user",
        entityId: user.id,
        metadata: { reason },
      });
    });
  }

  /** Zoekt een geldige sessie bij een token. Verlopen, ingetrokken of inactieve sessies leveren null. */
  async resolveSession(token: string): Promise<SessionInfo | null> {
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - this.config.SESSION_IDLE_TIMEOUT_MINUTES * 60_000);
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, sha256(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          gt(sessions.lastSeenAt, idleCutoff),
        ),
      )
      .limit(1);
    if (!row || !row.user.isActive) return null;

    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
    }
    return { sessionId: row.session.id, user: row.user, mfaVerified: row.session.mfaVerified };
  }

  async logout(sessionId: string) {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  /** Start 2FA-instelling: genereert een nieuw geheim (nog niet actief tot bevestiging). */
  async startMfaSetup(user: User) {
    if (user.totpEnabledAt) throw conflict("mfa_already_enabled", "Tweestapsverificatie is al ingesteld");
    const secret = generateTotpSecret();
    await this.db
      .update(users)
      .set({ totpSecretEncrypted: encryptSecret(secret, this.config.ENCRYPTION_KEY) })
      .where(eq(users.id, user.id));
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, this.config.APP_NAME) };
  }

  /** Bevestigt 2FA met een eerste code. Levert eenmalige herstelcodes op. */
  async enableMfa(user: User, sessionId: string, code: string, actor: ActorContext) {
    if (user.totpEnabledAt) throw conflict("mfa_already_enabled", "Tweestapsverificatie is al ingesteld");
    if (!user.totpSecretEncrypted) throw badRequest("mfa_setup_not_started", "Start eerst de instelling");
    const step = verifyTotp(decryptSecret(user.totpSecretEncrypted, this.config.ENCRYPTION_KEY), code);
    if (step === null) throw badRequest("invalid_code", "Code onjuist");

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpEnabledAt: new Date(), totpLastStep: step })
        .where(eq(users.id, user.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
      await tx.insert(recoveryCodes).values(codes.map((c) => ({ userId: user.id, codeHash: sha256(normalizeCode(c)) })));
      await tx.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, sessionId));
      await recordAudit(tx, actor, { action: "auth.mfa_enabled", entityType: "user", entityId: user.id });
    });
    return { recoveryCodes: codes };
  }

  /** Stap 2 van inloggen: TOTP-code of herstelcode. */
  async verifyMfa(user: User, sessionId: string, input: { code?: string; recoveryCode?: string }, actor: ActorContext) {
    if (!user.totpEnabledAt || !user.totpSecretEncrypted) {
      throw badRequest("mfa_not_enabled", "Tweestapsverificatie is nog niet ingesteld");
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, "account_locked", "Account tijdelijk geblokkeerd na te veel mislukte pogingen");
    }

    let method: "totp" | "recovery_code" | null = null;
    await this.db.transaction(async (tx) => {
      if (input.code) {
        const step = verifyTotp(decryptSecret(user.totpSecretEncrypted!, this.config.ENCRYPTION_KEY), input.code);
        if (step !== null && (user.totpLastStep === null || step > user.totpLastStep)) {
          await tx.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
          method = "totp";
        }
      } else if (input.recoveryCode) {
        const used = await tx
          .update(recoveryCodes)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(recoveryCodes.userId, user.id),
              eq(recoveryCodes.codeHash, sha256(normalizeCode(input.recoveryCode))),
              isNull(recoveryCodes.usedAt),
            ),
          )
          .returning({ id: recoveryCodes.id });
        if (used.length) method = "recovery_code";
      }
      if (method) {
        await tx.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, sessionId));
        await tx.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
        await recordAudit(tx, actor, {
          action: "auth.mfa_verified",
          entityType: "user",
          entityId: user.id,
          metadata: { method },
        });
      }
    });

    if (!method) {
      await this.registerFailure(user, actor, "wrong_mfa_code");
      throw badRequest("invalid_code", "Code onjuist");
    }
  }

  async changePassword(user: User, sessionId: string, current: string, next: string, actor: ActorContext) {
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw badRequest("invalid_credentials", "Huidig wachtwoord onjuist");
    }
    assertPasswordPolicy(next);
    const passwordHash = await hashPassword(next);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      // Alle andere sessies vervallen: wie het oude wachtwoord kende, is eruit.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), notThisSession(sessionId)));
      await recordAudit(tx, actor, { action: "auth.password_changed", entityType: "user", entityId: user.id });
    });
  }
}

const notThisSession = (sessionId: string) => ne(sessions.id, sessionId);

const normalizeCode = (code: string) => code.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
/** 10 hexadecimale tekens (40 bits), leesbaar gesplitst: "a1b2c-3d4e5". */
const generateRecoveryCode = () => {
  const hex = randomBytes(5).toString("hex");
  return `${hex.slice(0, 5)}-${hex.slice(5)}`;
};
