import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { sha256 } from "../../lib/crypto.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { passkeys, recoveryCodes, sessions, users, webauthnChallenges, type User } from "./schema.js";
import { generateRecoveryCode, mfaMethod, normalizeCode, type AuthService } from "./service.js";

const CHALLENGE_MS = 2 * 60_000;
const RECOVERY_CODE_COUNT = 10;

/**
 * Passkeys (WebAuthn). De passkey hoort bij het domein uit APP_BASE_URL (bv. crm.gecko.nl) en werkt
 * alleen op dat adres. Altijd met gebruikersverificatie (Face ID, vingerafdruk, pincode van het toestel):
 * zo is een passkey op zichzelf twee factoren en mag hij ook zonder wachtwoord inloggen.
 */
export class PasskeyService {
  readonly rpID: string;
  readonly origin: string;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly auth: AuthService,
  ) {
    const url = new URL(config.APP_BASE_URL);
    this.rpID = url.hostname;
    this.origin = url.origin;
  }

  private async saveChallenge(purpose: "register" | "login" | "verify", challenge: string, userId: string | null) {
    // Oude uitdagingen opruimen (klein houden).
    await this.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date()));
    const [row] = await this.db
      .insert(webauthnChallenges)
      .values({ purpose, challenge, userId, expiresAt: new Date(Date.now() + CHALLENGE_MS) })
      .returning({ id: webauthnChallenges.id });
    return row!.id;
  }

  /** Uitdaging ophalen en meteen verwijderen (eenmalig). */
  private async takeChallenge(id: string, purpose: string, userId: string | null) {
    const [row] = await this.db
      .delete(webauthnChallenges)
      .where(and(eq(webauthnChallenges.id, id), eq(webauthnChallenges.purpose, purpose), gt(webauthnChallenges.expiresAt, new Date())))
      .returning();
    if (!row || (userId !== null && row.userId !== userId)) throw badRequest("passkey_expired", "Verlopen; probeer het opnieuw");
    return row.challenge;
  }

  private userPasskeys(userId: string) {
    return this.db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));
  }

  // ---------------------------------------------------------------- Registreren

  async registrationOptions(user: User) {
    const existing = await this.userPasskeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: this.config.APP_NAME,
      rpID: this.rpID,
      userName: user.email ?? user.username ?? user.id,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports ?? undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { challengeId: await this.saveChallenge("register", options.challenge, user.id), options };
  }

  /**
   * Passkey opslaan. Is dit de eerste 2FA-methode (bij het instellen), dan telt de sessie meteen als
   * geverifieerd en krijgt de gebruiker herstelcodes.
   */
  async register(user: User, sessionId: string, input: { challengeId: string; response: RegistrationResponseJSON; name: string }, actor: ActorContext) {
    const expectedChallenge = await this.takeChallenge(input.challengeId, "register", user.id);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw badRequest("passkey_invalid", `Passkey kon niet worden gecontroleerd: ${err instanceof Error ? err.message : "onbekende fout"}`);
    }
    if (!verification.verified) throw badRequest("passkey_invalid", "Passkey kon niet worden gecontroleerd");
    const info = verification.registrationInfo;
    const first = mfaMethod(user) === null;
    const codes = first ? Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode) : null;
    const name = input.name.trim().slice(0, 80) || "Passkey";
    await this.db.transaction(async (tx) => {
      await tx.insert(passkeys).values({
        userId: user.id,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: info.credential.counter,
        transports: info.credential.transports ?? null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name,
      });
      if (!user.passkeyEnabledAt) await tx.update(users).set({ passkeyEnabledAt: new Date() }).where(eq(users.id, user.id));
      if (codes) {
        await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
        await tx.insert(recoveryCodes).values(codes.map((c) => ({ userId: user.id, codeHash: sha256(normalizeCode(c)) })));
        await tx.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, sessionId));
      }
      await recordAudit(tx, actor, { action: "auth.passkey_added", entityType: "user", entityId: user.id, metadata: { name, deviceType: info.credentialDeviceType, firstMfa: first } });
    });
    return { recoveryCodes: codes };
  }

  // ---------------------------------------------------------------- Inloggen

  /** Inloggen zonder wachtwoord: de browser biedt de passkeys van dit domein aan. */
  async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required" });
    return { challengeId: await this.saveChallenge("login", options.challenge, null), options };
  }

  /** 2FA-stap na het wachtwoord: alleen de passkeys van deze gebruiker. */
  async verifyOptions(user: User) {
    const own = await this.userPasskeys(user.id);
    if (!own.length) throw badRequest("no_passkey", "Er is nog geen passkey voor dit account");
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
      allowCredentials: own.map((p) => ({ id: p.credentialId, transports: p.transports ?? undefined })),
    });
    return { challengeId: await this.saveChallenge("verify", options.challenge, user.id), options };
  }

  /** Controleert het antwoord van het toestel en werkt de teller bij. Geeft de passkey en gebruiker terug. */
  private async check(challenge: string, response: AuthenticationResponseJSON) {
    const [row] = await this.db
      .select({ passkey: passkeys, user: users })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(eq(passkeys.credentialId, response.id));
    if (!row) throw badRequest("passkey_unknown", "Deze passkey is niet (meer) bekend. Log in met je wachtwoord.");
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: row.passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(row.passkey.publicKey, "base64url")),
          counter: row.passkey.counter,
          transports: row.passkey.transports ?? undefined,
        },
      });
    } catch {
      throw badRequest("passkey_invalid", "Passkey niet geaccepteerd. Probeer het opnieuw.");
    }
    if (!verification.verified) throw badRequest("passkey_invalid", "Passkey niet geaccepteerd. Probeer het opnieuw.");
    await this.db
      .update(passkeys)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date(), backedUp: verification.authenticationInfo.credentialBackedUp })
      .where(eq(passkeys.id, row.passkey.id));
    return row;
  }

  async login(input: { challengeId: string; response: AuthenticationResponseJSON }, meta: { ip?: string; userAgent?: string; requestId?: string }) {
    const challenge = await this.takeChallenge(input.challengeId, "login", null);
    const { user } = await this.check(challenge, input.response);
    return this.auth.startPasskeySession(user, meta);
  }

  async verify(user: User, sessionId: string, input: { challengeId: string; response: AuthenticationResponseJSON }, actor: ActorContext) {
    const challenge = await this.takeChallenge(input.challengeId, "verify", user.id);
    const row = await this.check(challenge, input.response);
    if (row.user.id !== user.id) throw badRequest("passkey_invalid", "Deze passkey hoort bij een ander account");
    await this.db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, sessionId));
    await recordAudit(this.db, actor, { action: "auth.mfa_verified", entityType: "user", entityId: user.id, metadata: { method: "passkey" } });
  }

  // ---------------------------------------------------------------- Beheer

  async list(userId: string) {
    const rows = await this.userPasskeys(userId);
    return rows.map((p) => ({ id: p.id, name: p.name, deviceType: p.deviceType, backedUp: p.backedUp, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
  }

  /**
   * Passkey verwijderen. Is het de laatste en de enige 2FA-methode, dan stelt de gebruiker bij de
   * volgende login opnieuw 2FA in (als 2FA verplicht is).
   */
  async remove(user: User, id: string, actor: ActorContext) {
    await this.db.transaction(async (tx) => {
      const [gone] = await tx.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id))).returning();
      if (!gone) throw notFound("Passkey");
      const left = await tx.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, user.id));
      if (!left.length) await tx.update(users).set({ passkeyEnabledAt: null }).where(eq(users.id, user.id));
      await recordAudit(tx, actor, { action: "auth.passkey_removed", entityType: "user", entityId: user.id, metadata: { name: gone.name, last: !left.length } });
    });
  }
}

