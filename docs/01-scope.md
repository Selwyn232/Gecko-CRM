# 01 — Scope en uitgangspunten

## Wat Gecko doet

Gecko BV ontzorgt consumenten volledig bij het verduurzamen van hun woning. Productgroepen:
thuisbatterijen, warmtepompen, zonnepanelen en isolatie.

- **Verkoop** gebeurt via verkoopkanalen: Greenteam (verkoopt op naam van Gecko BV), een web-only
  kanaal en een binnendienst. Elk kanaal heeft eigen productgroepen en prijzen.
- **Gecko** is eigenaar van de klant, factureert de consument, doet klantenservice en planning.
- **Installatiepartners** (verwachting: 8) schouwen, bereiden voor en installeren.
- **Materiaal** wordt door Gecko besteld bij OSW en geleverd bij de partner of de klant.

## Volume

100.000 klanten in 3 jaar ≈ 130 nieuwe projecten per werkdag op piek. Uitgangspunt:
**maximaal automatiseren**; personeel schaalt mee met wat niet te automatiseren is.

## Gebruikersgroepen

| Groep | Toegang |
|---|---|
| Gecko-medewerkers | Back-office (rollen beheerbaar: klantspecialist, planner, finance, beheerder, …) |
| Verkooppartner (Greenteam) + adviseurs | Offertes maken, eigen klanten/projecten inzien — via UI en API |
| Installatiepartners | Partnerportaal: beschikbaarheid, afspraken, rapporten, meerwerk — later ook API |
| Consument | Klantportaal: status, documenten, betalen, afspraken verzetten |

## Wat het systeem is

Eén systeem waaruit Gecko werkt. Bestaande systemen worden **gekoppeld**, niet nagebouwd:

| Functie | Systeem |
|---|---|
| Boekhouding | Exact Online (koppeling) |
| Betalingen | Betaalprovider, voorkeur Mollie (iDEAL/Wero + overschrijving met kenmerk) |
| WhatsApp | WhatsApp Business API via een BSP |
| Telefonie | VoIP-provider met API (bv. Voys / Aircall / Twilio) |
| Digitale handtekening | Eigen of extern (te bepalen) |
| Materiaal | OSW (bestellen, eventueel koppeling) |

## Grens van configureerbaarheid

**Zelf instelbaar** (zonder developer): fases, statussen en overgangen; automatiseringen en triggers;
bericht- en documentsjablonen; producten, stuklijsten, prijslijsten en inkoopprijzen; kanalen;
rollen en rechten; termijnen (betaaltermijn, herinneringen, omplanvenster); regio's; meerwerkcatalogus;
sanctieregels.

**Vast in code**: factuurnummering, btw-logica, creditnota's, geldstromen, selfbilling-berekening,
het datamodel, koppelingen, autorisatie-handhaving, audit log.
