# 07 — Architectuur en techniek

## Stack (besloten)

- **TypeScript** overal (frontend en backend) — gangbaar, makkelijk een developer voor te vinden.
- **PostgreSQL** als database.
- Hosting op **Render**, EU-regio (Frankfurt). Data blijft in de EU.

### Detailkeuzes

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Monorepo | pnpm workspaces (`apps/*`, `packages/*`) | Backend, frontend en gedeelde code in één repo |
| HTTP-framework | Fastify 5 | Snel, volwassen, goede TypeScript-ondersteuning |
| Validatie | Zod (ook gedeeld met de frontend) | Eén definitie voor types én invoercontrole |
| Database-toegang | Drizzle ORM + gegenereerde SQL-migraties | Dicht bij SQL, migraties leesbaar en gecommit |
| Wachtwoorden | Argon2id | Huidige aanbeveling (OWASP) |
| 2FA | TOTP (RFC 6238), eigen implementatie getest op RFC-vectoren | Werkt met elke authenticator-app |
| Tests | Vitest tegen echte PostgreSQL | Constraints en triggers worden mee getest |
| CI | GitHub Actions | Typecheck, migratiecontrole, tests, build bij elke push |
| Frontend | Nog te kiezen bij de start van de back-office UI (voorstel: React + Vite of Next.js) | |
| Sms (2FA) | `CM_PRODUCT_TOKEN` (product token uit het CM.com-portaal, zelf in te vullen) en optioneel `SMS_SENDER` (max. 11 letters/cijfers, standaard "Gecko"). Zonder token kunnen gebruikers alleen de authenticator-app kiezen |
| Achtergrondtaken | Nog te kiezen bij eerste behoefte (voorstel: pg-boss, draait op PostgreSQL) | Geen extra infrastructuur |

Werkwijze en conventies: zie [10 — Ontwikkelen](10-ontwikkelen.md).

## Architectuurprincipes

- **Eén applicatie (modulaire monoliet)**, opgedeeld in duidelijke modules (klanten, producten,
  projecten/journey, financieel, communicatie, planning, portalen). Geen microservices: te veel beheer
  voor één developer.
- **API-first**: dezelfde API bedient back-office, portalen, Greenteam en later partners.
- **Achtergrondtaken** (queue) voor alles wat traag of extern is: e-mail, WhatsApp, Exact-sync,
  AI, PDF's, herinneringen. Met retries en zichtbare foutstatus.
- **Gebeurtenissen** (`project.status_changed`, `invoice.paid`, …) sturen automatiseringen aan.
- **Bestanden** (foto's, PDF's, opnames) in object storage, niet in de database.
- **Geld** altijd in centen (integer), nooit floating point.

## Backups en herstel

Doel: geen dataverlies van betekenis en snel herstel.

| Laag | Maatregel |
|---|---|
| Database | Point-in-time recovery (herstel tot op de minuut) via Render Postgres |
| Database | Daarnaast dagelijkse versleutelde dump naar **aparte** opslag bij een andere aanbieder (EU): zie [12 — Backup en herstel](12-backup.md) |
| Bestanden | Object storage met versiebeheer en kopie naar tweede locatie |
| Retentie | Dagelijks 30 dagen, maandelijks 12 maanden, jaarlijks 7 jaar (fiscale bewaarplicht) |
| Test | Elk kwartaal een herstel-test naar een losse omgeving, gedocumenteerd |

## Beveiliging

- 2FA verplicht voor medewerkers en partners.
- Rollen en rechten beheerbaar; afscherming per organisatie afgedwongen in de database.
- Volledige audit log (wie, wat, wanneer, oud → nieuw).
- Geheimen alleen in de omgevingsconfiguratie, nooit in de code.
- Aparte omgevingen: productie, staging (zonder echte klantdata), lokaal.

## AVG

- Gecko is (voorlopig aangenomen) verwerkingsverantwoordelijke; Greenteam en installatiepartners
  verwerkers → verwerkersovereenkomsten (juridisch te bevestigen).
- Functies voor inzage-, correctie- en verwijderverzoeken.
- Bewaartermijnen per gegevenssoort; financiële gegevens 7 jaar, overige gegevens korter waar mogelijk.

## Hosting op Render (huidige stand)

| Onderdeel | Instelling |
|---|---|
| Webservice | `gecko-crm-web` (plan Starter, geen slaapstand), regio Frankfurt, Node 22. Adres: **https://crm.gecko.nl** (CNAME bij Hostnet naar `gecko-crm-web.onrender.com`; certificaat via Render). `APP_BASE_URL=https://crm.gecko.nl`. Deployt automatisch bij elke push naar de ontwikkelbranch |
| Build | `npx -y pnpm@10.28.0 install --frozen-lockfile --prod=false && npx -y pnpm@10.28.0 build` |
| Start | `node apps/api/dist/cli/bootstrap.js && node apps/api/dist/server.js` (eerst migraties en basisgegevens, dan de server) |
| Database | `gecko-crm-db`, PostgreSQL 16, plan Basic 1 GB, 5 GB opslag, regio Frankfurt, point-in-time recovery actief |
| Variabelen | `DATABASE_URL`, `ENCRYPTION_KEY`, `NODE_ENV=production`, `NODE_VERSION=22`, `APP_BASE_URL` |
| E-mail (zelf in te vullen) | `MAILGUN_API_KEY` (verzendsleutel van het domein), `MAILGUN_DOMAIN`, `MAILGUN_REGION=eu`, optioneel `MAIL_FROM` en `MAIL_REPLY_TO`. Klik-/open-tracking staat per bericht uit (transactionele mail). Zonder deze variabelen worden e-mails alleen vastgelegd, niet verstuurd |
| Betalen | `MOLLIE_API_KEY` (zelf in te vullen). Zonder sleutel: testmodus met gesimuleerde betaalpagina `/testbetaling/:id`. Webhook: `/api/public/payments/mollie/webhook` |
| Achtergrondtaken | In hetzelfde proces (`JOBS_ENABLED`): automatiseringen uit de outbox elke 5 s, aanmaningen elk uur. Bij meerdere servers naar een aparte worker |
| E-mail (huidige stand) | Mailgun, domein `mail.gecko.nl` in de **EU-regio**, afzender `Gecko <selwyn@gecko.nl>` (MAIL_FROM), antwoordadres `selwyn@gecko.nl` (MAIL_REPLY_TO). DNS (SPF, DKIM, MX, DMARC `p=none`, tracking-CNAME) bij Hostnet. DMARC later aanscherpen naar `quarantine` |

Eenmalig bij een lege database: `BOOTSTRAP_ADMIN_EMAIL` en `BOOTSTRAP_ADMIN_PASSWORD` maken de eerste beheerder aan,
`SEED_DEMO=true` laadt voorbeelddata. Verwijder deze variabelen daarna.

**Nog te doen vóór echte klantdata:** dagelijkse versleutelde dump naar aparte opslag bij een andere aanbieder,
herstel-test, en de duur van point-in-time recovery controleren (hangt af van het Render-werkruimteplan).

`ENCRYPTION_KEY` nooit wijzigen of kwijtraken: daarmee zijn de 2FA-geheimen versleuteld.

## Inkomende e-mail (inbox)

Mailgun-route `forward("https://crm.gecko.nl/api/public/inbound/mailgun")` voor het serviceadres. Het CRM controleert de handtekening met `MAILGUN_WEBHOOK_SIGNING_KEY` (Mailgun → Settings → Webhooks → HTTP webhook signing key). Zonder die variabele is de inbox uit.

Overige nieuwe variabele: `TRUST_PROXY_HOPS` (aantal vertrouwde proxy's; zie O27).
