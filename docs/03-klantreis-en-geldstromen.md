# 03 — Klantreis en geldstromen

De volledige customer journey (berichten per stap) volgt later. Dit is het **skelet** met de vaste
financiële ankerpunten. Fasen en berichten worden configureerbaar; de geldmomenten zijn harde regels.

## Projectflow (per project)

```
 1. Offerte gemaakt (verkoopkanaal, op naam Gecko BV)
 2. Offerte getekend → order
        → voorcalculatie wordt vastgelegd
 3. Financiering (optioneel: Warmtefonds / SVN) — kan maanden duren
 4. Schouw ingepland (door systeem, op beschikbaarheid partner)
        → AANBETALINGSFACTUUR 70% verstuurd
        → vervaldatum = vroegste van (factuurdatum + betaaltermijn) en (schouwdatum − X dagen)
 5. Aanbetaling ontvangen  ← harde voorwaarde vóór de schouw
        → SELFBILLING GREENTEAM: fee over orderwaarde ex btw + meerwerk (zie 04)
 6. Schouw uitgevoerd door installatiepartner → schouwrapport
 7. Schouw goedgekeurd
        → evt. meerwerkvoorstel uit vaste catalogus → klant tekent digitaal
 8. Installatie ingepland → materiaal besteld bij OSW (levering 1 dag vooraf)
 9. Installatie uitgevoerd → opleverrapport + foto's + klanthandtekening
10. Oplevering gecontroleerd (mens, later AI) → "werkend opgeleverd"
        → EINDFACTUUR 30% + meerwerk
11. Eindbetaling ontvangen
        → SELFBILLING INSTALLATEUR: vaste prijs + goedgekeurd meerwerk − sancties
12. Afgerond → nacalculatie wordt vastgelegd
13. Nazorg: service, garantie, onderhoud
```

## Uitzonderingspaden (moeten in de flow bestaan)

| Situatie | Gedrag (voorstel, instelbaar) |
|---|---|
| Aanbetaling niet op tijd binnen | Schouw automatisch op pauze, taak voor klantspecialist |
| Schouw afgekeurd | Project naar "technisch niet haalbaar" → annulering/creditnota |
| Klant akkoordeert meerwerk niet | Taak; keuze: zonder meerwerk door of annuleren |
| Meerwerk dat schouw miste | Geen kosten voor klant; vastgelegd als kosten partner (partner schouwt zelf) |
| Partner komt niet / niet beschikbaar | Afspraak opnieuw plannen + `PartnerPenalty` |
| Oplevering met restpunten | Status "opgeleverd met restpunten"; eindfactuur pas na oplossing (te bevestigen) |
| Klant betaalt niet | Aanmaanflow (zie 04) |
| Annulering na order | Creditnota's, terugbetaling, selfbilling-correctie |

## Warmtefonds

Betaalwijze is per project vastgelegd (`payment_method`: direct / warmtefonds / …). Bij Warmtefonds
wijkt de flow af (aanvraagstatus, uitbetaling direct aan Gecko, mogelijk niet in 70/30).
Het exacte proces moet nog worden uitgezocht (zie 09).

## Lange doorlooptijd → prijsvastheid

Tussen verkoop en installatie zitten soms maanden. Verkoopprijs ligt vast bij ondertekening;
inkoopprijzen kunnen in de tussentijd stijgen. Voorcalculatie gebruikt inkoopprijzen op orderdatum,
nacalculatie de werkelijke. Het verschil wordt zichtbaar per project en in rapportages.
