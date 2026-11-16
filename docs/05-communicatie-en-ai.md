# 05 — Communicatie en AI

## Eén inbox

Alle klantcommunicatie komt binnen in één tijdlijn per klant (en per project):

| Kanaal | Werking |
|---|---|
| E-mail | Gedeelde mailbox, inkomend gekoppeld aan klant op adres/kenmerk |
| WhatsApp | Business API via BSP. Buiten het 24-uursvenster alleen goedgekeurde sjablonen |
| Telefonie | VoIP met API: opname → transcript → AI-samenvatting in tijdlijn |
| Klantportaal | Berichten vanuit het portaal |
| Interne notitie | Alleen zichtbaar voor medewerkers |

Automatische journey-berichten gaan via hetzelfde systeem, zodat de tijdlijn compleet is.

## AI-principes (versie 1)

- AI **stelt voor**, de mens beslist en verstuurt. Geen autonome klantcommunicatie.
- AI-taken: inkomend bericht classificeren en koppelen, conceptantwoord, samenvatting van
  gesprek/klantdossier, voorgestelde actie (bv. "afspraak verzetten"), controle opleverrapport (later).
- Elke AI-suggestie wordt gelogd (voorgesteld / aangepast / verstuurd / afgewezen) — basis om later
  per onderwerp autonomie toe te staan.
- Onderwerpen die nooit autonoom mogen worden configureerbaar (bv. klachten, geld, schade).

## Telefonie

- Melding van opname aan begin gesprek; bewaartermijn opname instelbaar (voorstel: opname verwijderen
  na transcriptie, transcript + samenvatting bewaren).
- Inkomend nummer → klant automatisch herkend → dossier open bij medewerker.

## AVG

Klantcommunicatie bevat persoonsgegevens; AI-verwerking gebeurt bij een aanbieder met EU-verwerking
en verwerkersovereenkomst. Geen training op klantdata.
