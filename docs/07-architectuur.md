# 07 — Architectuur en techniek

## Stack (besloten)

- **TypeScript** overal (frontend en backend) — gangbaar, makkelijk een developer voor te vinden.
- **PostgreSQL** als database.
- Hosting op **Render**, EU-regio (Frankfurt). Data blijft in de EU.

Detailkeuzes (framework, ORM, jobqueue) worden vastgelegd bij de start van de bouw in dit document.

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
| Database | Daarnaast dagelijkse versleutelde dump naar **aparte** opslag bij een andere aanbieder (EU) |
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
