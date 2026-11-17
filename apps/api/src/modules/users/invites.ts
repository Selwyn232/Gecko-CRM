import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import { systemActor, type ActorContext } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { AppError, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { assertPasswordPolicy, hashPassword } from "../auth/password.js";
import { accountInvites, sessions, users } from "../auth/schema.js";
import { button, escapeHtml, layout } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { organizations } from "../organizations/schema.js";
import { getCompany } from "../quotes/links.js";

export const INVITE_DAYS = 7;
export const RESET_MINUTES = 60;

/**
 * Uitnodiging maken en mailen: de ontvanger stelt via de link zelf een wachtwoord in (daarna 2FA bij de
 * eerste login). Eerdere openstaande uitnodigingen van deze gebruiker vervallen. Geeft de link terug,
 * zodat een beheerder hem ook zelf kan doorsturen als e-mail (nog) niet is ingesteld.
 */
export async function sendInvite(db: Db, transport: EmailTransport | null, baseUrl: string, actor: ActorContext, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("Gebruiker");
  if (!user.email) throw new AppError(400, "no_email", "Deze gebruiker heeft geen e-mailadres; een uitnodiging kan niet worden verstuurd");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organizationId));
  const token = randomToken();
  const url = `${baseUrl.replace(/\/$/, "")}/account-activeren/${token}`;
  await db.transaction(async (tx) => {
    await tx.update(accountInvites).set({ usedAt: new Date() }).where(and(eq(accountInvites.userId, userId), isNull(accountInvites.usedAt)));
    await tx.insert(accountInvites).values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000), createdBy: actor.userId });
    await recordAudit(tx, actor, { action: "user.invited", entityType: "user", entityId: userId, metadata: { email: user.email } });
  });
  const company = await getCompany(db);
  const isPartner = org?.type === "installation_partner";
  const html = `<p>Beste ${escapeHtml(user.name)},</p>
<p>Er is een account voor u aangemaakt in ${escapeHtml(company.name)} CRM${org && org.type !== "gecko" ? ` voor ${escapeHtml(org.name)}` : ""}.${
    isPartner ? " Hier ziet u uw opdrachten (schouwen en installaties), geeft u uw beschikbaarheid door, levert u rapporten aan en accordeert u uw uitbetalingen." : ""
  }</p>
<p>Klik op de knop om uw wachtwoord in te stellen. Daarna stelt u tweestapsverificatie in met een authenticator-app.</p>
${button(url, "Account activeren")}
<p style="font-size:13px;color:#5f6b62">Deze link werkt één keer en is ${INVITE_DAYS} dagen geldig. Uw gebruikersnaam is uw e-mailadres: ${escapeHtml(user.email)}.</p>`;
  const mail = await sendEmail(db, transport, {
    to: user.email,
    subject: `Uw account voor ${company.name} CRM`,
    html: layout(company, html),
    text: `${html.replace(/<[^>]+>/g, "").trim()}\n\nAccount activeren: ${url}`,
    template: "account.invite",
  });
  return { url, emailStatus: mail.status as string, email: user.email };
}

async function openInvite(db: DbOrTx, token: string) {
  const [row] = await db
    .select({ invite: accountInvites, user: users, organizationName: organizations.name })
    .from(accountInvites)
    .innerJoin(users, eq(users.id, accountInvites.userId))
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(eq(accountInvites.tokenHash, sha256(token)));
  if (!row || row.invite.usedAt || row.invite.expiresAt < new Date() || !row.user.isActive) {
    throw new AppError(400, "invite_invalid", "Deze link is verlopen of al gebruikt. Vraag via 'Wachtwoord vergeten?' een nieuwe aan, of vraag Gecko om een nieuwe uitnodiging.");
  }
  return row;
}

/** Gegevens voor de activatiepagina (zonder iets te wijzigen). */
export async function inviteInfo(db: DbOrTx, token: string) {
  const { invite, user, organizationName } = await openInvite(db, token);
  return { name: user.name, email: user.email, organizationName, mfaRequired: user.mfaRequired, purpose: invite.purpose as "invite" | "reset" };
}

/** Wachtwoord instellen via de uitnodiging; de link is daarna niet meer te gebruiken. */
export async function acceptInvite(db: Db, token: string, password: string, ip?: string) {
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const { invite, user } = await openInvite(tx, token);
    const [claimed] = await tx
      .update(accountInvites)
      .set({ usedAt: new Date() })
      .where(and(eq(accountInvites.id, invite.id), isNull(accountInvites.usedAt)))
      .returning({ id: accountInvites.id });
    if (!claimed) throw new AppError(400, "invite_invalid", "Deze activatielink is al gebruikt.");
    await tx.update(users).set({ passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
    // Na een wachtwoordherstel: overal afmelden (wie het oude wachtwoord kende, is eruit).
    if (invite.purpose === "reset") await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
    await recordAudit(tx, { ...systemActor(), userId: user.id, ip }, { action: invite.purpose === "reset" ? "user.password_reset_by_link" : "user.invite_accepted", entityType: "user", entityId: user.id });
    return { email: user.email };
  });
}

/**
 * "Wachtwoord vergeten": stuurt een herstellink (1 uur geldig, eenmalig) naar het e-mailadres, als dat bij een
 * actief account hoort. Het antwoord is altijd hetzelfde, zodat niet te achterhalen is welke adressen bestaan.
 * Na herstel blijft 2FA (Face ID, app of sms) gewoon nodig.
 */
export async function requestPasswordReset(db: Db, transport: EmailTransport | null, baseUrl: string, emailInput: string, ip?: string) {
  const email = emailInput.trim().toLowerCase();
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (!user || !user.isActive || !user.email) return;
  // Niet vaker dan eens per 2 minuten per account (tegen spammen van iemands mailbox).
  const [recent] = await db
    .select({ id: accountInvites.id })
    .from(accountInvites)
    .where(and(eq(accountInvites.userId, user.id), eq(accountInvites.purpose, "reset"), gt(accountInvites.createdAt, new Date(Date.now() - 2 * 60_000))))
    .limit(1);
  if (recent) return;
  const token = randomToken();
  const url = `${baseUrl.replace(/\/$/, "")}/wachtwoord-herstellen/${token}`;
  await db.transaction(async (tx) => {
    await tx.update(accountInvites).set({ usedAt: new Date() }).where(and(eq(accountInvites.userId, user.id), eq(accountInvites.purpose, "reset"), isNull(accountInvites.usedAt)));
    await tx.insert(accountInvites).values({ userId: user.id, purpose: "reset", tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000) });
    await recordAudit(tx, { ...systemActor(), userId: user.id, ip }, { action: "user.password_reset_requested", entityType: "user", entityId: user.id });
  });
  const company = await getCompany(db);
  const html = `<p>Beste ${escapeHtml(user.name)},</p>
<p>Er is gevraagd om het wachtwoord van uw account bij ${escapeHtml(company.name)} CRM opnieuw in te stellen. Klik op de knop om een nieuw wachtwoord te kiezen.</p>
${button(url, "Nieuw wachtwoord instellen")}
<p style="font-size:13px;color:#5f6b62">Deze link werkt één keer en is ${RESET_MINUTES} minuten geldig. Daarna logt u in met uw nieuwe wachtwoord en uw tweede stap (Face ID, app of sms). Heeft u dit niet zelf aangevraagd? Dan kunt u deze e-mail negeren; uw wachtwoord blijft ongewijzigd.</p>`;
  await sendEmail(db, transport, {
    to: user.email,
    subject: `Wachtwoord opnieuw instellen voor ${company.name} CRM`,
    html: layout(company, html),
    text: `${html.replace(/<[^>]+>/g, "").trim()}\n\nNieuw wachtwoord instellen: ${url}`,
    template: "account.password_reset",
  });
}
