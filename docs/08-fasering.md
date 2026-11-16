# 08 — Fasering

## Versie 1 — eerste klant kan er volledig doorheen

- Fundament: authenticatie, 2FA, rollen/rechten, audit log, instellingen
- Klanten, woningen, projecten
- Productcatalogus, stuklijsten, prijslijsten per kanaal, inkoop- en partnerprijzen (met versies)
- Offertes (ook via API voor Greenteam) + digitale handtekening → order
- Configureerbare statusflow per productgroep + basis-automatiseringen (e-mail bij statuswissel — gebouwd, zie Klantberichten)
- Facturatie (aanbetaling, eind, credit) + Exact-koppeling + Mollie
- Herinneringen en aanmaanflow
- Voor- en nacalculatie op de klantkaart
- Partnerportaal basis: afspraken, schouw- en opleverrapport, foto's, meerwerk
- Selfbilling Greenteam en installateurs (gebouwd, zie B43)
- Basisrapportages (gebouwd, B45): doorlooptijd per fase, marge per productgroep/partner/kanaal, first-time-right
  installaties, cashflowprognose (openstaande en verwachte betalingen)

## Versie 2 — communicatie en zelfservice

- Eén inbox: e-mail (gebouwd, B60; aan te zetten via O28) + WhatsApp (nog te kiezen aanbieder)
- AI-voorstellen (classificatie, conceptantwoord, samenvatting)
- Klantportaal (gebouwd, B48: status, documenten, betalen, meerwerk akkoorderen, afspraak verzetten)
- Automatisch plannen op beschikbaarheid + sancties (planvoorstel en ploegen gebouwd, B50)

## Versie 3 — verdieping

- Telefonie met transcriptie en samenvatting
- Klant plant zelf om (gebouwd in Mijn Gecko, B48)
- AI-controle opleverrapporten
- Partner-API (API-sleutels gebouwd voor verkooppartners, B59)
- Nazorg/servicemodule, serienummerbeheer uitgebreid
- Warmtefonds-flow (zodra proces bekend)
- Uitgebreide rapportages, NPS

De volgorde binnen een versie wordt bepaald door wat de eerste klant als eerste nodig heeft.
