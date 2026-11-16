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

### Nog te bepalen (zie 09)

- Regio-definitie (postcodegebieden / provincies).
- Capaciteitseenheid (ploegen per dag × duur per producttype).
- Of Gecko de schouw soms zelf doet.
