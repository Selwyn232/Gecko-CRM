# 10 — Ontwikkelen: werkwijze en conventies

Dit document is voor iedereen die aan de code werkt (ook de toekomstige developer en Claude).
Doel: het systeem moet over jaren nog veilig aan te passen zijn.

## Opbouw

**Modulaire monoliet.** Eén applicatie, opgedeeld in modules onder `apps/api/src/modules/`.
Elke module heeft dezelfde drie bestanden:

| Bestand | Verantwoordelijkheid |
|---|---|
| `schema.ts` | Databasetabellen (Drizzle). Alleen structuur, geen logica |
| `service.ts` | Alle bedrijfsregels. Weet niets van HTTP; krijgt `db` en `actor` mee |
| `routes.ts` | HTTP: invoervalidatie (Zod), rechtencheck, aanroepen van de service |

Regels:
- Bedrijfslogica staat **alleen** in services. Routes zijn dun. Zo kan dezelfde logica later
  ook vanuit achtergrondtaken, automatiseringen of de partner-API worden aangeroepen.
- Een module mag de service van een andere module aanroepen, niet diens tabellen direct wijzigen.
- Elke wijziging die ertoe doet, schrijft een regel in het audit log (`recordAudit`), **in dezelfde
  transactie** als de wijziging.

## Databasewijzigingen

1. Pas `schema.ts` van de module aan.
2. `pnpm --filter @gecko/api db:generate` → nieuw SQL-bestand in `apps/api/drizzle/`.
3. Lees het gegenereerde SQL na en commit het mee.
4. Nooit een bestaande migratie wijzigen; altijd een nieuwe toevoegen.
5. Voor zaken die Drizzle niet genereert (triggers, data-migraties):
   `npx drizzle-kit generate --custom --name <naam>`.

Kolom hernoemen of verwijderen in productie: in twee stappen (eerst nieuw naast oud, code omzetten,
daarna oud verwijderen), zodat een deploy nooit halverwege breekt.

## Vaste conventies

| Onderwerp | Afspraak |
|---|---|
| Geld | Integer centen, exclusief btw tenzij de naam anders zegt (`...Cents`) |
| Percentages | Basispunten (`2100` = 21%) |
| Datums met bedrijfsbetekenis | `date` (YYYY-MM-DD), "vandaag" = Europe/Amsterdam (`todayIso()`) |
| Tijdstippen | `timestamptz` |
| Id's | UUID |
| Prijzen en tarieven | Nooit overschrijven: nieuwe versie met `valid_from`; ingegane versies onveranderbaar |
| Historische documenten | Slaan een snapshot op van prijzen/btw (niet ernaar verwijzen) |
| Fouten | `AppError` met stabiele Engelse `code` en Nederlandse `message` |
| Naamgeving | Code en database in het Engels, UI en documentatie in het Nederlands |

## Rechten

- Rechten staan in `modules/auth/permissions.ts`. Nieuw recht: daar toevoegen met omschrijving,
  in de route gebruiken met `preValidation: requirePermission("...")`.
- Rollen zijn data en door beheerders in te stellen. De rol `beheerder` heeft altijd alle rechten.
- Elke route is standaard afgeschermd (ingelogd + 2FA). Openbaar maken kan alleen expliciet met
  `config: { auth: "public" }`.

## Tests

- Tests draaien tegen een echte PostgreSQL (`gecko_test`), niet tegen mocks: zo worden constraints,
  triggers en migraties mee getest.
- Elke bedrijfsregel krijgt een test. Bij een bug: eerst een test die faalt, dan de fix.
- `test/helpers.ts` heeft hulpfuncties voor gebruikers met rollen en een volledige 2FA-login.

## Beveiliging

- Wachtwoorden: Argon2id, minimaal 12 tekens. 2FA (TOTP) verplicht voor iedereen.
- Sessietokens en herstelcodes alleen gehasht opgeslagen; 2FA-geheimen versleuteld (AES-256-GCM).
- Accountblokkade na 5 mislukte pogingen (15 min) + rate limiting op inloggen.
- Het audit log is onveranderbaar afgedwongen met een databasetrigger.
- Geheimen alleen via omgevingsvariabelen; nooit committen.
