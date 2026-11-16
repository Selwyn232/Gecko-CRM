# 09 — Besluiten en open punten

## Besluiten

| # | Besluit | Datum |
|---|---|---|
| B1 | Zelf bouwen; later developer voor onderhoud. Externe systemen koppelen, één werkomgeving | 2026-11-16 |
| B2 | Gecko BV is eigenaar van de klant en factureert de consument | 2026-11-16 |
| B3 | Greenteam maakt offertes in Gecko CRM (UI/API); factureert zelf niets via Gecko | 2026-11-16 |
| B4 | Meerdere verkoopkanalen (Greenteam, web, binnendienst) met eigen productgroepen en prijzen | 2026-11-16 |
| B5 | Klant → woning → project; één productgroep per project, eigen statusflow | 2026-11-16 |
| B6 | Voor- en nacalculatie; prijzen met versies en snapshots | 2026-11-16 |
| B7 | Exact Online als boekhouding; facturen opgemaakt in CRM | 2026-11-16 |
| B8 | 70% aanbetaling na inplannen schouw, betaald vóór schouw; 30% + meerwerk na werkende oplevering | 2026-11-16 |
| B9 | Meerwerk alleen uit vaste catalogus en met formeel klantakkoord | 2026-11-16 |
| B10 | Aanmaanflow volgt WIK (herinnering → 14-dagenbrief → incasso) | 2026-11-16 |
| B11 | Selfbilling: Greenteam-fee na aanbetaling (per adviseur gespecificeerd), installateur na eindbetaling | 2026-11-16 |
| B12 | Installatiepartner schouwt zelf; gemist meerwerk voor rekening partner | 2026-11-16 |
| B13 | Oplevering: rapport + foto's + klanthandtekening; controle eerst menselijk, later AI | 2026-11-16 |
| B14 | Niet nakomen beschikbaarheid → financiële sanctie | 2026-11-16 |
| B15 | AI stelt voor, mens verstuurt | 2026-11-16 |
| B16 | Grens configureerbaarheid zoals in 01 | 2026-11-16 |
| B17 | TypeScript + PostgreSQL, hosting EU; uitgebreide backups (zie 07) | 2026-11-16 |
| B18 | Fasering zoals in 08 | 2026-11-16 |
| B19 | Inloggen met e-mail of gebruikersnaam. 2FA standaard verplicht, per gebruiker uit te zetten door een beheerder (afgeraden). Startwachtwoorden moeten bij eerste login worden vervangen | 2026-11-16 |
| B20 | Accounts selwyn, renee, barry, jurriaan: beheerder, zonder 2FA (op verzoek, tegen advies in) | 2026-11-16 |
| B21 | Klantreis per productgroep: statussen met fase, start/eind, en expliciet toegestane overgangen; volledig instelbaar | 2026-11-16 |
| B23 | Offerte per productgroep; akkoord maakt automatisch het project aan. Prijzen/btw/kostprijs/fee vastgezet bij definitief maken; wijzigen via nieuwe versie | 2026-11-16 |
| B24 | Kostprijs en marge alleen zichtbaar met recht op inkoopprijzen. Fee per verkoopkanaal instelbaar (basispunten) | 2026-11-16 |
| B25 | Akkoord voorlopig handmatig geregistreerd (naam, wijze); digitale handtekening en e-mailverzending volgen | 2026-11-16 |
| B22 | Domeingebeurtenissen via een outbox-tabel, basis voor automatische e-mails/WhatsApp per status | 2026-11-16 |

## Open punten

| # | Vraag | Eigenaar |
|---|---|---|
| O1 | Kan één offerte/order meerdere projecten bevatten (combikorting, gecombineerde schouw)? Eén of meerdere aanbetalingsfacturen? | Gecko (overleg) |
| O2 | Fee-percentage(s) per kanaal en regels bij annulering/creditnota | Gecko |
| O3 | Warmtefonds/SVN: hoe en wanneer keren zij uit, en in welke delen? | Gecko (navragen) |
| O4 | Regio-definitie en capaciteitseenheid voor beschikbaarheid | Gecko |
| O5 | Doet Gecko soms zelf de schouw? | Gecko |
| O6 | Materiaallevering bij partner of bij klant | Gecko + partners |
| O7 | Subsidies (ISDE) en aanmelding netbeheerder: onderdeel van ontzorging? | Gecko |
| O8 | Gedrag bij oplevering met restpunten: eindfactuur wachten of deels factureren? | Gecko |
| O9 | AVG-rollen en verwerkersovereenkomsten juridisch bevestigen | Jurist |
| O10 | Zelffactureringsovereenkomsten met Greenteam en partners | Jurist / finance |
| O11 | Vervaldatum aanbetaling: hoeveel dagen vóór de schouw (X)? Wat bij niet betalen? | Gecko |
| O12 | Leverancier digitale handtekening, WhatsApp-BSP, telefonie | Te kiezen in v1/v2 |
| O14 | 2FA weer verplicht maken voor alle beheerders zodra er echte klantdata in staat | Gecko |
| O15 | Leverancier digitale handtekening offertes (bv. via e-mail-link met akkoordknop of externe partij) | Gecko |
| O16 | Bedrijfsgegevens Gecko BV (adres, KvK, btw-nummer, IBAN) voor offerte en factuur | Gecko |
| O13 | Verkoopprijs vast bij ondertekening, ook als inkoop stijgt tijdens lange wachttijd? | Gecko |
