import { and, eq, isNull } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import { systemActor, type ActorContext } from "../../lib/context.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { AppError, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { assertPasswordPolicy, hashPassword } from "../auth/password.js";
import { accountInvites, users } from "../auth/schema.js";
import { button, escapeHtml, layout } from "../email/layout.js";
import { sendEmail } from "../email/service.js";
import type { EmailTransport } from "../email/transport.js";
import { organizations } from "../organizations/schema.js";
import { getCompany } from "../quotes/links.js";

export const INVITE_DAYS = 7;

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
    throw new AppError(400, "invite_invalid", "Deze activatielink is verlopen of al gebruikt. Vraag Gecko om een nieuwe uitnodiging.");
  }
  return row;
}

/** Gegevens voor de activatiepagina (zonder iets te wijzigen). */
export async function inviteInfo(db: DbOrTx, token: string) {
  const { user, organizationName } = await openInvite(db, token);
  return { name: user.name, email: user.email, organizationName, mfaRequired: user.mfaRequired };
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
    await recordAudit(tx, { ...systemActor(), userId: user.id, ip }, { action: "user.invite_accepted", entityType: "user", entityId: user.id });
    return { email: user.email };
  });
}
