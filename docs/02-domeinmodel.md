# 02 — Domeinmodel

Eerste versie. Namen in het Engels zoals ze in de code komen.

## Kern: klant, woning, project

```
Customer (consument)
 └─ Property (woning, adres, BAG-id)        1 klant : n woningen
     └─ Project                             1 woning : n projecten
          - precies 1 productgroep
          - eigen statusflow (journey)
          - eigen installatiepartner, afspraken, facturen, calculatie
```

- Een project bevat **één productgroep**. Koopt een klant panelen én een batterij, dan zijn dat twee projecten.
- Of één offerte/order meerdere projecten kan omvatten (combikorting, gecombineerde schouw) is **open** (zie 09).
  Het model houdt die ruimte: `Quote 1:n Project` is mogelijk zonder herbouw.

## Verkoop

| Entiteit | Belangrijkste velden / opmerkingen |
|---|---|
| `SalesChannel` | Greenteam, Web, Binnendienst. Bepaalt prijslijst, toegestane productgroepen, fee-regel |
| `SalesPartner` | Organisatie achter een kanaal (Greenteam). Selfbilling-ontvanger |
| `Advisor` | Adviseur van een salespartner. Wordt per offerte vastgelegd voor fee-specificatie |
| `Quote` | Offerte op naam van Gecko BV. Versies, geldigheid, kanaal, adviseur, status, handtekening |
| `QuoteLine` | Product, aantal, verkoopprijs (snapshot), btw-tarief (snapshot) |
| Order | Een getekende offerte wordt een order; start projecten |

## Producten en prijzen

| Entiteit | Opmerkingen |
|---|---|
| `ProductGroup` | Thuisbatterij, warmtepomp, zonnepanelen, isolatie |
| `Product` | Code (SKU), type: `package` / `component` / `labor` / `extra_work` / `service` |
| `BillOfMaterials` | Pakket → componenten + arbeid (aantallen). Basis voor voorcalculatie |
| `PriceList` / `PriceListItem` | Verkoopprijs per kanaal, met `valid_from` / `valid_to` |
| `PurchasePrice` | Inkoopprijs per product per leverancier, met `valid_from` / `valid_to` |
| `PartnerRate` | Vaste installatieprijs per partner per pakket/arbeid, met geldigheid |
| `VatRule` | Btw per product, inclusief splitsing arbeid/materiaal (isolatie) |
| `ExtraWorkCatalog` | Vaste meerwerkproducten met verkoop- en inkoopprijs |

**Regel:** prijzen worden nooit overschreven, alleen nieuwe versies met een ingangsdatum. Elke offerte-,
factuur- en calculatieregel slaat een **snapshot** op van de prijs die toen gold.

## Uitvoering

| Entiteit | Opmerkingen |
|---|---|
| `InstallationPartner` | Partner, contracten, regio's, sanctieregels |
| `Region` | Definitie nog open (postcodegebieden of provincies) |
| `Availability` | Capaciteit per partner per regio per dag |
| `Appointment` | Type: `survey` (schouw) / `installation` / `service`. Partner, tijdslot, status |
| `SurveyReport` | Schouwrapport: checklist, foto's, goed-/afkeur, voorgesteld meerwerk |
| `ExtraWorkProposal` | Meerwerk na schouw: regels uit catalogus, klantakkoord (handtekening) |
| `CompletionReport` | Opleverrapport: checklist, foto's, klanthandtekening, controle (mens → later AI) |
| `UnforeseenExtraWork` | Meerwerk dat de schouw miste: geen kosten klant, voor rekening van partner — wel geregistreerd |
| `MaterialOrder` | Bestelling bij OSW, leveradres (partner of klant), leverdatum |
| `InstalledAsset` | Serienummers van geïnstalleerde apparatuur (garantie, service) |
| `PartnerPenalty` | Sanctie bij niet nakomen beschikbaarheid/afspraak; verrekend via selfbilling |
| `ServiceCase` | Storing, garantie, klacht na oplevering |

## Financieel

| Entiteit | Opmerkingen |
|---|---|
| `Invoice` | Verkoopfactuur. Type: `deposit` (70%) / `final` (30% + meerwerk) / `credit` |
| `InvoiceLine` | Productcode, omschrijving, bedrag, btw-tarief — gelijk aan productcatalogus |
| `PaymentRequest` | Betaallink bij provider |
| `Payment` | Ontvangen betaling (iDEAL, overschrijving, Warmtefonds) |
| `DunningStep` | Herinnering, WIK-14-dagenbrief, overdracht incasso |
| `SelfBillingInvoice` | Inkoopfactuur die Gecko namens partner opmaakt (Greenteam-fee, installateur) |
| `SelfBillingLine` | Per project; bij Greenteam inclusief adviseur. Sancties als negatieve regel |
| `Calculation` | Voorcalculatie (bij order) en nacalculatie (na afronding), als snapshot |

## Communicatie

| Entiteit | Opmerkingen |
|---|---|
| `Conversation` | Draad met klant, gekoppeld aan klant en eventueel project |
| `Message` | Kanaal: `email` / `whatsapp` / `phone` / `portal` / `internal_note`. Richting in/uit |
| `CallRecording` | Opname-metadata, transcript, AI-samenvatting |
| `AiSuggestion` | Conceptantwoord / voorgestelde actie; status: voorgesteld / aangepast / verstuurd / afgewezen |
| `Task` | Taak voor medewerker, eventueel door AI of automatisering aangemaakt |
| `Template` | Bericht- en documentsjablonen per kanaal |

## Klantreis (configureerbaar)

| Entiteit | Opmerkingen |
|---|---|
| `JourneyDefinition` | Flow per productgroep (en eventueel per kanaal), met versie |
| `JourneyStage` / `JourneyStatus` | Fasen en statussen |
| `JourneyTransition` | Toegestane overgang + voorwaarden (bv. "aanbetaling ontvangen") |
| `Automation` | Trigger (statuswissel, tijd, gebeurtenis) → acties (bericht, taak, factuur, …) |
| `ProjectStatusHistory` | Elke statuswissel met tijd en veroorzaker — basis voor doorlooptijd-KPI's |

## Platform

`User`, `Role`, `Permission` (beheerbaar), `AuditLog` (wie wijzigde wat, oud → nieuw), `Document`/`File`
(object storage), `Setting`, `ApiClient` (API-toegang voor Greenteam en partners), `Webhook`.

## Autorisatie (principe)

Data wordt afgeschermd op **organisatie**: Greenteam ziet alleen projecten uit eigen kanaal, een
installatiepartner alleen projecten waaraan die is toegewezen, een klant alleen eigen gegevens.
Dit wordt in de database afgedwongen, niet alleen in de UI.
