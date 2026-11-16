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
| B41 | Testmodus (instelling, standaard uit): vandaag plannen, rapporten direct indienen, testscenario's met testklant, "Testinstallateur (test)" (met partnertarief) en standaard verkoopkanaal "Greenteam (test)" (testkopie met adviseur en fee; e-mails naar het testadres, echte Greenteam blijft ongemoeid). Paarse balk zolang aan; uitzetten vóór echte klanten | 2026-11-16 |
| B38 | Partner niet gekomen: boete €250 (instelbaar), automatisch geregistreerd, kwijt te schelden met reden; verrekening via selfbilling | 2026-11-16 |
| B42 | Klantberichten: per status in de klantreis een e-mail (aan/uit, tekst met invulvelden), plus vaste berichten bij afspraak ingepland/geannuleerd en een herinnering de dag vóór de afspraak (vanaf 9:00). Standaardteksten worden nooit overschreven; elk bericht hooguit één keer (dedupe), alles zichtbaar op de klantkaart. Beheer: Klantberichten (recht journeys.manage) | 2026-11-16 |
| B43 | Selfbilling: posten worden uitbetaalbaar bij betaalde aanbetaling (fee verkooppartner, per offerte incl. meerwerk, per adviseur) resp. betaalde eindfactuur (installateur: vast partnertarief op het pakket, anders arbeid uit de stuklijst, plus meerwerk tegen partnertarief van de offertedatum). Openstaande boetes worden als negatieve regel (buiten btw) verrekend. Handmatig gebundeld per partner: concept → definitief (eigen nummerreeks per partner, onveranderbaar, "Factuur uitgereikt door afnemer", gemaild) → betaald. Fee-percentage vastgezet bij versturen offerte; was het toen niet ingesteld, dan geldt het actuele percentage van het kanaal. Btw: verkooppartner 21%, installateur standaard verlegd, per partner aan te passen. Export CSV voor Exact | 2026-11-16 |
| B44 | Selfbilling alleen uitbetalen na akkoord van de ontvanger: bij definitief maken gaat een e-mail met persoonlijke akkoordlink (nieuwe link vervangt de oude). Ontvanger geeft akkoord of "niet akkoord" met reden, via de link of het partnerportaal. Vastgelegd: naam, tijd, IP, apparaat, e-mailadres, methode en inhoud-hash (in factuur en logboek); een gegeven akkoord is onveranderbaar (databasetrigger) en "betaald" kan in de database pas na akkoord. Bij niet akkoord krijgt Gecko een e-mail; na overleg opnieuw ter akkoord sturen. Akkoord via "Inloggen als" alleen in testmodus (gelogd) | 2026-11-16 |
| B45 | Rapportages (menu Rapportages): doorlooptijd per status uit de statusgeschiedenis, projecten die langer dan X dagen in een status staan, marge (voorcalculatie bij akkoord) per productgroep/kanaal/installateur met wat via selfbilling werkelijk is afgerekend, first-time-right per installateur (opleverrapport nooit afgekeurd) en een cashflowprognose van 8 weken. Marge alleen met recht op inkoopprijzen, cashflow alleen met factuurrechten | 2026-11-16 |
| B46 | Nacalculatie per project (projectkaart, en marge per project op de klantkaart): omzet, materiaal, installateur, boetes en fee — voor (offerte, prijzen van de offertedatum) naast na (facturen incl. creditnota's, definitieve selfbilling, boetes). Nog niet afgerekend = verwacht. Werkelijke inkoop volgt via Exact. Alleen met recht op inkoopprijzen | 2026-11-16 |
| B47 | Checklists schouw/oplevering per productgroep zelf in te stellen (Beheer → Checklists): punten, verplicht ja/nee, minimum aantal foto's. Gelden bij een positief rapport; ingediende rapporten bewaren de punten op tekst. Startlijst is algemeen (O23) | 2026-11-16 |
| B48 | Klantportaal "Mijn Gecko" (/mijn): inloggen zonder wachtwoord met eenmalige e-maillink (30 min), sessie 30 dagen; klant = alle klantrecords met dat e-mailadres. Toont per project fases, status, afspraken, offertes en facturen (geen interne gegevens). Betalen online, offerte/meerwerk accepteren via de bestaande akkoordflow (met code), afspraak verzetten bij dezelfde installateur tot X dagen vooraf (instelling). Medewerker kan klant uitnodigen vanaf de klantkaart | 2026-11-16 |
| B49 | Startpagina "Mijn werk": per gebruiker (volgens rechten) wat aandacht nodig heeft — rapporten beoordelen, schouw met open aanbetaling, in te plannen schouw/installatie, meerwerk-offertes versturen, offertes zonder reactie (> 5 dagen), projecten die blijven hangen, facturen over vervaldatum, selfbilling niet akkoord / uit te betalen / klaar om te factureren | 2026-11-16 |
| B50 | Meerdere ploegen per installatiepartner (Organisaties → aantal ploegen): zoveel afspraken passen tegelijk in een beschikbaar dagdeel. Planvoorstel bij het inplannen: beste 3 momenten op basis van snelheid, drukte van de partner en of de partner die dag al in de buurt (PC2) is, met uitleg; de planner bevestigt | 2026-11-16 |
| B51 | Project annuleren in één keer (statusknop "Geannuleerd"): geplande afspraken vervallen, openstaande offertes afgewezen, gekozen facturen gecrediteerd, status geannuleerd (kan vanuit elke open status). Nog niet afgerekende fee/installatie wordt niet meer uitbetaald. Terugbetalen en al afgerekende selfbilling corrigeren blijven handwerk en worden gemeld (O2) | 2026-11-16 |
| B52 | Klanttijdlijn op de klantkaart (notities, belnotities, e-mails, statuswissels, afspraken, offertes, facturen, betalingen; filterbaar). Notities zijn intern. Zoekbalk in de zijbalk (toets /): klant op naam, e-mail, telefoon, postcode, adres, en K-/P-/O-/F-nummers; resultaten volgens rechten | 2026-11-16 |
| B53 | Verkooppartnerportaal voor Greenteam: gebruikers met rol "Verkooppartner" in de organisatie Greenteam maken klanten en offertes (catalogus en prijzen van hun kanaal, geen kostprijzen), versturen ze ter akkoord, volgen de projectstatus en zien hun fee. Gekoppeld aan een adviseur (bij Gebruikers) = alleen eigen offertes/klanten; zonder koppeling = hele organisatie | 2026-11-16 |
| B54 | Beveiligingsreview (16-11): geen rechten uitdelen of accounts resetten met meer rechten dan je zelf hebt; niet inloggen-als een gebruikersbeheerder; geen 2FA instellen tijdens inloggen-als; blokkade pas melden na juist wachtwoord; testbetalingen live alleen in testmodus; CSV-exports zonder formules; meerwerk alleen uit de eigen catalogus | 2026-11-16 |
| B55 | Selfbilling automatisch bundelen (instelling "Selfbilling: elke maandag automatisch conceptfacturen", standaard uit): maandag vanaf 9:00 een concept per partner zonder open concept; definitief maken blijft handwerk. CSV-exports van klanten, projecten en offertes (volgens rechten, gelogd) | 2026-11-16 |
| B56 | Taken (klantkaart: titel, voor wie, deadline, project; afvinken) en meldingen (belletje): bij een toegewezen taak, ingediend rapport, geaccepteerde offerte, factuur naar incasso en selfbilling "niet akkoord". Open taken met deadline binnen 7 dagen op Mijn werk | 2026-11-16 |
| B22 | Domeingebeurtenissen via een outbox-tabel, basis voor automatische e-mails/WhatsApp per status | 2026-11-16 |

## Open punten

| # | Vraag | Eigenaar |
|---|---|---|
| O1 | Kan één offerte/order meerdere projecten bevatten (combikorting, gecombineerde schouw)? Eén of meerdere aanbetalingsfacturen? | Gecko (overleg) |
| O2 | Fee-percentage(s) per kanaal (in te stellen bij Verkoopkanalen; zonder percentage geen uitbetaling) en regels bij annulering/creditnota (nu via correctieregel) | Gecko |
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
| O23 | Checklists schouw/oplevering per productgroep inhoudelijk vaststellen (nu generiek) — zelf in te voeren bij Beheer → Checklists | Gecko + partners |
| O24 | ~~Partners met meerdere ploegen~~ — gebouwd (B50); aantal ploegen per partner invullen | Gecko |
| O25 | Btw bij selfbilling installateurs: standaard "verlegd" (onderaanneming). Laten bevestigen door de accountant, per partner aan te passen bij Organisaties | Accountant |
| O26 | ~~Selfbilling wekelijks bundelen~~ — gebouwd als instelling (B55), standaard uit | Gecko |
| O27 | IP-adres achter de proxy van Render: aantal hops controleren (logregel "login proxy chain") en TRUST_PROXY_HOPS instellen; tot dan is het IP (pogingenlimiet, bewijs bij akkoorden) te vervalsen | Techniek |
| O13 | Verkoopprijs vast bij ondertekening, ook als inkoop stijgt tijdens lange wachttijd? | Gecko |
