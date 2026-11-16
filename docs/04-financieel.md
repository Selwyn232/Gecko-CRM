# 04 — Financieel

## Facturatie

- Facturen worden **in Gecko CRM** opgemaakt, met regels die 1-op-1 uit de productcatalogus komen.
- Greenteam maakt offertes in Gecko CRM (UI of API); Greenteam factureert zelf niets via Gecko.
- **Doorlopende factuurnummering** per reeks, zonder gaten; een verstuurde factuur is onveranderbaar.
  Correcties uitsluitend via creditnota.
- **Btw per regel**: zonnepanelen 0%, batterij/warmtepomp 21%, isolatie arbeid 9% / materiaal 21%
  (tarieven via `VatRule`, met ingangsdatum, zodat wetswijzigingen geen code vragen).
- Naar de klant: pakketprijzen + eventueel meerwerk. Intern blijft de stuklijst gekoppeld.
- PDF-factuur + verzending per e-mail en zichtbaar in klantportaal.

## Exact Online

Gecko CRM is leidend voor facturen; Exact is leidend voor de boekhouding.

| Richting | Wat |
|---|---|
| CRM → Exact | Debiteuren, verkoopfacturen (geboekt, niet door Exact verstuurd), creditnota's |
| CRM → Exact | Crediteuren, selfbilling-inkoopfacturen (Greenteam, installateurs) |
| CRM → Exact | Betalingen / Mollie-uitbetalingen voor afletteren |
| Exact → CRM | Optioneel: bankmutaties voor overschrijvingen buiten Mollie om |

Productcodes en grootboekrekeningen worden per productgroep gemapt.

## Betalingen

- Betaallink via betaalprovider (voorkeur Mollie): iDEAL/Wero als eerste keus, **bankoverschrijving
  met uniek kenmerk** als terugval (bankdaglimieten bij bedragen ≥ €10.000).
- Betalingen worden automatisch aan de factuur gekoppeld via webhook.
- Warmtefonds-uitbetalingen worden als aparte betaalwijze geregistreerd.

## Termijnen en aanmaningen

Termijnen zijn instelbaar; de structuur volgt de wet (WIK, consument).

| Stap | Standaard |
|---|---|
| Factuur | Betaaltermijn 14 dagen (instelbaar; aanbetaling ook begrensd door schouwdatum) |
| Herinnering | Na vervaldatum: vriendelijk, betalen binnen 5 dagen |
| WIK-aanmaning (14-dagenbrief) | Wettelijk verplicht vóór incassokosten mogen worden gerekend |
| Overdracht incasso | Na verstrijken 14-dagenbrief; status en export naar incassobureau |

Elke stap kan worden gepauzeerd per klant (bv. bij een lopende klacht).

## Selfbilling

Gecko maakt de inkoopfacturen namens partners op. Vereist een **zelffactureringsovereenkomst** met elke
partner en een aparte factuurreeks per partner.

| Ontvanger | Bedrag | Moment |
|---|---|---|
| Greenteam | % fee over orderwaarde ex btw + meerwerk; specificatie per project **en per adviseur** | Zodra klant de aanbetaling heeft voldaan |
| Installatiepartner | Vaste partnerprijs + goedgekeurd meerwerk − sancties | Zodra klant de eindbetaling (30%) heeft voldaan |

Periodiek gebundeld (bv. wekelijks), met specificatie. Fee-percentage(s) zijn configureerbaar per
kanaal en worden later bepaald.

## Margeberekening (op de klantkaart)

Per project en opgeteld per klant:

```
Omzet       = verkoopprijs pakket + meerwerk (ex btw)
Kosten      = inkoop materiaal (stuklijst × inkoopprijs)
            + partnerprijs installatie + partnerprijs meerwerk
            + fee verkoopkanaal
            − sancties partner (verlaagt kosten)
Marge       = Omzet − Kosten   (absoluut en %)
```

- **Voorcalculatie**: snapshot bij order, met prijzen geldig op orderdatum.
- **Nacalculatie**: snapshot bij afronding, met werkelijke kosten (selfbilling, werkelijke OSW-prijs).
- Afwijking voor vs. na is zichtbaar per project en rapporteerbaar.
