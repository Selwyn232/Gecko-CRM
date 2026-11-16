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
| B20 | Accounts selwyn, renee, barry, jurriaan: zonder 2FA (op verzoek, tegen advies in). Account selwyn (beheerder) op verzoek van de eigenaar met eenvoudig wachtwoord, uitzondering op het wachtwoordbeleid; alleen accountblokkade na 5 pogingen beschermt | 2026-11-16 |
| B21 | Klantreis per productgroep: statussen met fase, start/eind, en expliciet toegestane overgangen; volledig instelbaar | 2026-11-16 |
| B23 | Offerte per productgroep; akkoord maakt automatisch het project aan. Prijzen/btw/kostprijs/fee vastgezet bij definitief maken; wijzigen via nieuwe versie | 2026-11-16 |
| B24 | Kostprijs en marge alleen zichtbaar met recht op inkoopprijzen. Fee per verkoopkanaal instelbaar (basispunten) | 2026-11-16 |
| B25 | Akkoord voorlopig handmatig geregistreerd (naam, wijze); digitale handtekening en e-mailverzending volgen | 2026-11-16 |
| B26 | Digitaal akkoord zelf gebouwd (geen externe partij): persoonlijke e-maillink + eenmalige code per e-mail; bewijs (e-mail, IP, apparaat, tijd, inhoud-hash) vastgelegd; bevestiging met volledige inhoud en bedenktijd per e-mail. Externe partij later per documentsoort mogelijk | 2026-11-16 |
| B27 | E-mail via Mailgun (EU). Elke uitgaande e-mail wordt vastgelegd, ook zonder koppeling | 2026-11-16 |
| B28 | Facturen: nummering F{jaar}-{volgnummer} zonder gaten; definitief = onveranderbaar (databasetrigger), correctie via creditnota | 2026-11-16 |
| B29 | Aanbetaling (standaard 70%) per offerteregel; eindfactuur = volledige offerte minus aanbetaling per btw-tarief. Factuurmomenten per status in de klantreis instelbaar | 2026-11-16 |
| B30 | Aanmaanflow: herinnering → 14-dagenbrief met WIK-kosten → overdracht incasso; termijnen instelbaar, pauze per factuur | 2026-11-16 |
| B31 | Betalen via Mollie; zonder Mollie-sleutel testmodus met gesimuleerde betaalpagina. Exact voorlopig via CSV-export | 2026-11-16 |
| B32 | Regio = set postcodegebieden (4 cijfers). Partner kiest werkgebied (regio's) en klikt per dag ochtend-/middagblokken aan (één blok = één ploeg). Schouw = één dagdeel, installatie = hele dag(en); installatieduur per productgroep | 2026-11-16 |
| B33 | Installatie bij dezelfde partner als de schouw. Capaciteit kan niet lager dan geplande afspraken; dubbel boeken voorkomen met vergrendeling | 2026-11-16 |
| B34 | Automatische statuswissels per gebeurtenis (schouw ingepland, rapport ingediend/goedgekeurd, meerwerk, betaald) instelbaar per status in de klantreis | 2026-11-16 |
| B35 | Partnerportaal: partner ziet alleen eigen afspraken; rapport met foto's; oplevering met handtekening klant; meerwerk alleen bij de schouw, via meerwerk-offerte ter akkoord bij klant | 2026-11-16 |
| B36 | Vervaldatum aanbetaling uiterlijk X dagen (instelbaar, standaard 2) vóór de schouwdatum | 2026-11-16 |
| B37 | Geplande schouw met onbetaalde aanbetaling wordt gesignaleerd (Planning → "Aanbetaling open", rode markering in de agenda); niet automatisch geannuleerd | 2026-11-16 |
| B39 | Nederland standaard verdeeld in 200 kaartgebieden: aaneengesloten PC4-reeksen binnen een PC2-reeks, verdeeld naar aantal postcodes (bron: CBS/Kadaster PC4-vlakken, CC BY 4.0; opbouw in scripts/build-nl-gebieden.py). Partners kiezen hun werkgebied op de kaart | 2026-11-16 |
| B40 | "Inloggen als" voor beheerders (recht users.impersonate): niet als jezelf of andere beheerder, max. 1 uur, zichtbare balk, start en alle acties gelogd met de beheerder erbij | 2026-11-16 |
| B41 | Testmodus (instelling, standaard uit): vandaag plannen, rapporten direct indienen, testscenario's met testklant en "Testinstallateur (test)". Paarse balk zolang aan; uitzetten vóór echte klanten | 2026-11-16 |
| B38 | Partner niet gekomen: boete €250 (instelbaar), automatisch geregistreerd, kwijt te schelden met reden; verrekening via selfbilling | 2026-11-16 |
| B42 | Klantberichten: per status in de klantreis een e-mail (aan/uit, tekst met invulvelden), plus vaste berichten bij afspraak ingepland/geannuleerd en een herinnering de dag vóór de afspraak (vanaf 9:00). Standaardteksten worden nooit overschreven; elk bericht hooguit één keer (dedupe), alles zichtbaar op de klantkaart. Beheer: Klantberichten (recht journeys.manage) | 2026-11-16 |
| B22 | Domeingebeurtenissen via een outbox-tabel, basis voor automatische e-mails/WhatsApp per status | 2026-11-16 |

## Open punten

| # | Vraag | Eigenaar |
|---|---|---|
| O1 | Kan één offerte/order meerdere projecten bevatten (combikorting, gecombineerde schouw)? Eén of meerdere aanbetalingsfacturen? | Gecko (overleg) |
| O2 | Fee-percentage(s) per kanaal en regels bij annulering/creditnota | Gecko |
| O3 | Warmtefonds/SVN: hoe en wanneer keren zij uit, en in welke delen? | Gecko (navragen) |
| O5 | Doet Gecko soms zelf de schouw? | Gecko |
| O6 | Materiaallevering bij partner of bij klant | Gecko + partners |
| O7 | Subsidies (ISDE) en aanmelding netbeheerder: onderdeel van ontzorging? | Gecko |
| O8 | Gedrag bij oplevering met restpunten: eindfactuur wachten of deels factureren? | Gecko |
| O9 | AVG-rollen en verwerkersovereenkomsten juridisch bevestigen | Jurist |
| O10 | Zelffactureringsovereenkomsten met Greenteam en partners | Jurist / finance |
| O12 | Leverancier digitale handtekening, WhatsApp-BSP, telefonie | Te kiezen in v1/v2 |
| O14 | 2FA weer verplicht maken voor alle beheerders zodra er echte klantdata in staat | Gecko |
| O17 | Accepteert het Warmtefonds een gewone elektronische handtekening, of is een geavanceerde nodig? | Gecko (navragen) |
| O16 | Bedrijfsgegevens Gecko BV (adres, KvK, btw-nummer, IBAN): nu FICTIEF ingevuld, vervangen via Organisaties → Gecko BV | Gecko |
| O18 | Mollie-account (vereist zakelijke rekening); daarna MOLLIE_API_KEY in Render | Gecko |
| O19 | Exact Online: administratie, grootboekrekeningen per productgroep, daarna API-koppeling | Gecko / finance |
| O21 | Foto's staan nu in de database; bij volume naar object storage (S3/R2, EU) | Techniek |
| O23 | Checklists schouw/oplevering per productgroep inhoudelijk vaststellen (nu generiek) — definitieve lijst volgt | Gecko + partners |
| O24 | Partners met meerdere ploegen tegelijk: instelling "aantal ploegen" per partner (nu één ploeg per blok) | Gecko |
| O13 | Verkoopprijs vast bij ondertekening, ook als inkoop stijgt tijdens lange wachttijd? | Gecko |
