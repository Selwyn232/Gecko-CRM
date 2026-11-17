# 12 — Backup en herstel

Twee lagen (zie ook [07 — Architectuur](07-architectuur.md#backups-en-herstel)):

1. **Render Postgres point-in-time recovery**: herstel tot op de minuut, binnen Render.
2. **Dagelijkse versleutelde dump bij een andere aanbieder** (dit document): beschermt tegen problemen
   met het Render-account zelf (uitsluiting, fout bij de aanbieder, per ongeluk verwijderde database).

## Hoe het werkt

| Onderdeel | Invulling |
|---|---|
| Job | Render **Cron Job** `gecko-crm-backup`, runtime Docker (`ops/backup/Dockerfile`), regio Frankfurt, elke nacht 02:15 UTC |
| Dump | `pg_dump` custom formaat, gecontroleerd met `pg_restore --list` (moet tabellen bevatten) |
| Versleuteling | [age](https://age-encryption.org) met een **publieke** sleutel. De privésleutel staat niet op de server en niet bij de opslag: wie de bucket of Render binnenkomt, kan de backups niet lezen |
| Opslag | S3-compatibel, EU. Voorstel: Scaleway Object Storage, regio `nl-ams` (Amsterdam) |
| Integriteit | De sha256 van het bestand zit in de handtekening van de upload; de opslag weigert een bestand dat onderweg is veranderd. Ook als metadata (`x-amz-meta-sha256`) opgeslagen |
| Mappen | `gecko-crm/daily/` elke dag, `gecko-crm/monthly/` op de 1e, `gecko-crm/yearly/` op 1 januari |
| Bewaren | Via lifecycle-regels in de bucket: daily 30 dagen, monthly 12 maanden (400 dagen), yearly 7 jaar (2600 dagen) |
| Rechten | De sleutel van de job mag alleen **schrijven** (geen lezen, geen verwijderen). Het script verwijdert nooit iets |
| Bewaking | Mislukt de job (exitcode ≠ 0), dan meldt Render dat per e-mail (Notifications → "Cron job failed") |

Inhoud: de volledige database, dus ook foto's en handtekeningen (die staan nu in de database, O21).
Niet in de backup: geheimen uit de omgevingsvariabelen (`ENCRYPTION_KEY` e.d.). **Bewaar
`ENCRYPTION_KEY` apart in de wachtwoordkluis**: zonder die sleutel zijn versleutelde velden
(o.a. MFA-geheimen) in een herstelde database onbruikbaar.

## Huidige stand (ingericht 17-11-2026)

| Onderdeel | Waarde |
|---|---|
| Opslag | Scaleway, project "Gecko Backup", bucket `gecko-crm-backups` in `nl-ams`, privé, zonder versioning |
| Bewaarregels | `daily-30`, `monthly-400`, `yearly-2600` (plus `test-1` voor `gecko-crm/test/`, 1 dag) |
| Schrijfsleutel | IAM-applicatie `gecko-backup`, policy `gecko-backup-policy` met alleen `ObjectStorageObjectsWrite`. Getest: schrijven lukt, lezen, verwijderen en de lijst opvragen worden geweigerd (403) |
| Render | Cron Job `gecko-crm-backup` (Frankfurt, starter), schema `15 2 * * *` UTC, Dockerfile `ops/backup/Dockerfile`, context `ops/backup`, zelfde branch als de webservice |
| Sleutel | Publieke age-sleutel `age16fg4zkdgz9fmu8fj7krqcd9ceappn6ln445mm8ewtd0ahcvmqu0sjglfuy`; privésleutel bij Selwyn (wachtwoordmanager en kluis) |
| Eerste run | 17-11-2026: 65 tabellen, ±2,4 MB versleuteld, `gecko-crm/daily/2026-11-17T1011.dump.age` |

Om te herstellen is een **leessleutel** nodig: maak die pas op het moment zelf aan (Scaleway IAM,
`ObjectStorageObjectsRead`) of download het bestand via de webconsole van Scaleway.

## Eenmalig instellen

1. **Sleutelpaar maken** (op een eigen computer, niet op de server):
   `age-keygen -o gecko-backup-sleutel.txt` (macOS: `brew install age`).
   - De regel `# public key: age1…` is de publieke sleutel → `BACKUP_AGE_RECIPIENT`.
   - Het bestand zelf is de privésleutel: in de wachtwoordkluis **én** op papier in de kluis.
     Kwijt = alle backups onbruikbaar.
2. **Opslag** (Scaleway): account → Object Storage → bucket `gecko-crm-backups` in `nl-ams`,
   privé. Lifecycle-regels instellen zoals hierboven (filter op prefix `gecko-crm/daily/` enz.).
3. **Sleutels** (Scaleway IAM): een applicatie `gecko-backup` met een policy die alleen
   `ObjectStorageObjectsWrite` geeft op het project → API-sleutel. Een tweede sleutel met
   leesrechten alleen aanmaken op het moment van herstellen.
4. **Render Cron Job**: New → Cron Job → deze repository, branch van productie, runtime Docker,
   Dockerfile-pad `ops/backup/Dockerfile`, context `ops/backup`, regio Frankfurt, schema `15 2 * * *`.
   Variabelen:

   | Variabele | Waarde |
   |---|---|
   | `DATABASE_URL` | Internal Database URL van `gecko-crm-db` |
   | `BACKUP_AGE_RECIPIENT` | `age1…` uit stap 1 |
   | `S3_ENDPOINT` | `https://s3.nl-ams.scw.cloud` |
   | `S3_REGION` | `nl-ams` |
   | `S3_BUCKET` | `gecko-crm-backups` |
   | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | uit stap 3 (geheim) |
   | `BACKUP_PREFIX` | optioneel, standaard `gecko-crm` |

5. **Direct testen**: "Trigger Run" in Render, in de logs moet `geüpload: …` en `klaar` staan,
   en het bestand moet in de bucket zichtbaar zijn. Daarna een hersteltest (hieronder).

## Herstellen

Altijd naar een **nieuwe, lege** database; nooit over productie heen. Het script weigert een database
die al tabellen heeft.

1. Download het gewenste bestand (`*.dump.age`) via de webconsole van de opslag.
2. Maak een lege database (lokaal, of een nieuwe Render Postgres).
3. `ops/backup/restore.sh <bestand.dump.age> <gecko-backup-sleutel.txt> <DATABASE_URL-van-lege-db>`
   (nodig: `age` en PostgreSQL-clienttools 16 of hoger). Het script toont aantallen klanten,
   projecten, facturen en het tijdstip van de laatste auditregel ter controle.
4. Bij een echte calamiteit: de webservice laten wijzen naar de herstelde database
   (`DATABASE_URL`), met dezelfde `ENCRYPTION_KEY` als voorheen.

## Hersteltest (elk kwartaal)

Stappen 1–3 hierboven op een lokale of tijdelijke database, en vastleggen in onderstaande tabel.
Daarna de tijdelijke database verwijderen (bevat echte klantgegevens).

| Datum | Backup van | Door | Resultaat |
|---|---|---|---|
| | | | |

## Onderhoud

- Upgrade van Render Postgres naar een nieuwe hoofdversie: `FROM postgres:16-alpine` in
  `ops/backup/Dockerfile` mee ophogen (pg_dump moet minstens dezelfde versie hebben).
- Sleutel vervangen: nieuw sleutelpaar, `BACKUP_AGE_RECIPIENT` aanpassen; de oude privésleutel
  bewaren zolang er backups mee versleuteld zijn (tot 7 jaar).
