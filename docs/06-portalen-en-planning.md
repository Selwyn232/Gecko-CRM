# 06 — Portalen en planning

## Partnerportaal (installatiepartners)

- Beschikbaarheid per regio per dag opgeven (capaciteit).
- Toegewezen schouwen en installaties inzien; werkbon met klant-, woning- en productinfo.
- Schouwrapport invullen: checklist, foto's, goed-/afkeur, meerwerk uit vaste catalogus.
- Opleverrapport: checklist, foto's, serienummers, klanthandtekening.
- Selfbilling-specificaties en sancties inzien.
- Later: API-koppeling voor partners met eigen systemen.

**Partner schouwt zelf** (voorkeur). Meerwerk dat bij de schouw gemist is, is voor rekening van de partner.

## Klantportaal

- Status per project, documenten (offerte, facturen, rapporten), betalen.
- Afspraak verzetten tot X dagen vooraf (instelbaar, standaard 14 dagen) — alleen naar slots waar
  capaciteit is. Binnen het venster: alleen via klantenservice.
- Meerwerk akkoorderen (digitale handtekening).
- Berichten sturen.

## Planning

- Systeem plant op basis van opgegeven beschikbaarheid; partner wordt daaraan gehouden.
- Niet nakomen → `PartnerPenalty` (financiële sanctie, verrekend via selfbilling), en meetbaar per partner.
- Materiaal: besteld bij OSW, levering 1 dag vooraf bij partner of klant (nog af te stemmen).
  Omplannen binnen het venster raakt de materiaallevering — daarom is het venster een harde grens.

### Monteurs, 2-uursblokken en rijtijd (B87)

- **Beschikbaarheid per monteur** in blokken van 2 uur: 08–10, 10–12, 12–14, 14–16. De partner (of de planner
  namens hem) klikt ze aan bij Beschikbaarheid → kies monteur.
- **Duur**: service en schouw 2 uur, installatie 6 uur per dag (meerdaagse installatie: elke dag dezelfde tijd).
- **Rijtijd**: het planvoorstel kijkt per monteur naar de klus ervoor en erna op die dag en rekent de rijtijd mee
  (Google Maps Distance Matrix, alleen postcodes; 30 dagen bewaard in `travel_times`). Zonder
  `GOOGLE_MAPS_API_KEY` een schatting op postcode (zelfde PC4 10 min … ander landsdeel 80 min).
- **Tijd voor de klant**: eerste klus van de dag "om 08:00 uur", anders "tussen 10:00 en 12:00 uur (verwachte
  aankomst)" — de geplande start min 1 uur tot plus 1 uur.
- **Monteursportaal** (rol Monteur, eigen inlog; partner beheert monteurs bij Monteurs):
  - *Mijn dag*: klussen op volgorde met tijd, adres, route en telefoon.
  - *Werkdag starten/beëindigen*: locatie wordt elke minuut doorgegeven zolang de pagina open is (06:00–20:00),
    7 dagen bewaard. Een web-app kan niet op de achtergrond volgen; daarvoor is later een app nodig.
  - *Ik vertrek*: rijtijd vanaf de huidige locatie (Google) → klant krijgt "Uw monteur is onderweg" met
    aankomsttijd (e-mail en WhatsApp; sjabloon "Monteur onderweg" bij Klantberichten).
  - *Aangekomen (aanmelden)* en *afmelden = opleveren* met het bestaande rapport (foto's, handtekening).

### Nog te bepalen (zie 09)

- Regio-definitie (postcodegebieden / provincies).
- Capaciteitseenheid (ploegen per dag × duur per producttype).
- Of Gecko de schouw soms zelf doet.
