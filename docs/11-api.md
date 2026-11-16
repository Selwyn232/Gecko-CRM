# 11 — API voor koppelingen

Voor een verkooppartner (Greenteam) die vanuit een eigen systeem offertes wil maken.

## Toegang

1. Maak bij **Gebruikers** een koppelgebruiker in de organisatie van de partner, met rol **Verkooppartner**
   (optioneel gekoppeld aan één adviseur).
2. Open die gebruiker → **API-sleutels** → *Sleutel maken*. Kopieer de sleutel (begint met `gk_`); hij wordt maar één keer getoond.
3. Elke aanvraag: `Authorization: Bearer gk_…`. Basis-URL: `https://crm.gecko.nl/api`.

De sleutel heeft precies de rechten van de koppelgebruiker en ziet alleen de eigen klanten, offertes en fee.
Intrekken kan direct bij dezelfde gebruiker. Gebruik en aanmaken worden gelogd.

## Endpoints (JSON)

| Methode | Pad | Doel |
|---|---|---|
| GET | `/sales/me` | Eigen organisatie, kanalen (met productgroepen) en adviseurs |
| GET | `/sales/catalog?channelId=&productGroupId=` | Producten met verkoopprijs (excl. btw, centen) |
| GET | `/sales/customers?q=` | Eigen klanten |
| POST | `/sales/customers` | Klant + woning aanmaken (`lastName`, `email`, `salesChannelId`, `property{street,houseNumber,postalCode,city}`) |
| GET | `/sales/quotes` | Eigen offertes met status en projectstatus |
| POST | `/sales/quotes` | Concept-offerte (`customerId`, `propertyId`, `productGroupId`, `salesChannelId`, `advisorId?`) |
| POST | `/sales/quotes/:id/lines` | Regel toevoegen (`productId`, `quantity`) |
| DELETE | `/sales/quotes/:id/lines/:lineId` | Regel verwijderen |
| POST | `/sales/quotes/:id/send` | Definitief maken en akkoordlink naar de klant mailen |
| GET | `/sales/quotes/:id` | Offerte (zonder kostprijs/marge) |
| GET | `/sales/fees` | Nog uit te betalen fee en selfbillingfacturen |

Bedragen in centen; datums `YYYY-MM-DD`. Fouten: `{ "error": { "code", "message" } }` met HTTP 400/401/403/404/409.
