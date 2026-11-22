# 14 — WhatsApp (Meta Cloud API)

Besluit B83. Klanten communiceren met Gecko via WhatsApp en e-mail. Alles wat per e-mail naar een klant gaat,
gaat ook via WhatsApp (behalve beveiligingscodes). Berichten van klanten komen bij hun klantspecialist (B81).

## Hoe het werkt

| Situatie | Wat het CRM stuurt |
|---|---|
| Klant stuurde de afgelopen 24 uur een bericht | De volledige tekst van de e-mail als gewoon WhatsApp-bericht; de specialist kan vrij typen |
| Langer dan 24 uur geleden (of nooit) | Een door Meta goedgekeurd sjabloon: `gecko_bericht` (onderwerp van de e-mail), of `gecko_welkom` / `gecko_nieuwe_contactpersoon` met de pasfoto van de specialist |
| Specialist wil contact buiten 24 uur | Knop "Uitnodiging sturen" → sjabloon `gecko_contact`; reageert de klant, dan kan er vrij getypt worden |
| Klant stuurt STOP | WhatsApp uit voor die klant (alleen nog e-mail); START zet het weer aan |
| Bericht van onbekend nummer | Komt binnen zonder klant; de manager klantenservice krijgt een melding |

- Alleen mobiele nummers (+316… of buitenlands); vaste nummers krijgen alleen e-mail.
- Per klant aan/uit op de klantkaart (blok WhatsApp).
- Status per bericht: verstuurd ✓, afgeleverd ✓✓, gelezen, mislukt (met reden).
- Menu **WhatsApp**: alle gesprekken; wie wacht op antwoord staat bovenaan, de langst wachtende eerst.
  Een klantspecialist ziet alleen eigen klanten.
- Foto's, documenten en spraakberichten van klanten worden als "[foto]" e.d. getoond; bekijken in het CRM volgt later.

## Eenmalig instellen bij Meta

1. **Meta Business-account** (business.facebook.com) voor Gecko BV en **bedrijfsverificatie** (KvK-uittreksel e.d.).
2. **developers.facebook.com → Mijn apps → App maken** (type Business) → product **WhatsApp** toevoegen.
3. **Telefoonnummer** toevoegen in WhatsApp Manager: een nummer dat **niet** in de gewone WhatsApp(-Business)-app
   wordt gebruikt (anders eerst daar verwijderen). Weergavenaam "Gecko" laten goedkeuren.
4. **Permanente toegangssleutel**: Bedrijfsinstellingen → Gebruikers → **Systeemgebruikers** → systeemgebruiker
   (beheerder) → app en WhatsApp-account toewijzen → **Token genereren** met de rechten
   `whatsapp_business_messaging` en `whatsapp_business_management`, geen vervaldatum.
5. **Sjablonen** in WhatsApp Manager → Berichtsjablonen → maken, categorie **Utility**, taal **Nederlands**, exact
   de tekst uit het CRM (menu WhatsApp, blok "WhatsApp koppelen"). Bij `gecko_welkom` en
   `gecko_nieuwe_contactpersoon` een kop van het type **Afbeelding**.
6. **Webhook**: in de app → WhatsApp → Configuratie → Webhook:
   - Callback-URL: `https://crm.gecko.nl/api/public/whatsapp/webhook`
   - Verify token: zelf een lange willekeurige tekst kiezen (zelfde als `WHATSAPP_VERIFY_TOKEN`)
   - Daarna bij Webhook-velden **messages** aanzetten.
   Zet eerst de variabelen in Render (stap 7), anders mislukt de controle van Meta.
7. **Render** (gecko-crm-web → Environment), allemaal geheim behalve het nummer-id:

   | Variabele | Waar te vinden |
   |---|---|
   | `WHATSAPP_TOKEN` | Stap 4 |
   | `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → API-instellingen → "Telefoonnummer-ID" (niet het telefoonnummer zelf) |
   | `WHATSAPP_APP_SECRET` | App → Instellingen → Basis → App-geheim |
   | `WHATSAPP_VERIFY_TOKEN` | Zelf gekozen tekst uit stap 6 |

8. **Testen**: zet je eigen mobiele nummer op een testklant, stuur een WhatsApp naar het Gecko-nummer en kijk in
   het CRM (menu WhatsApp). Antwoord vanuit de klantkaart.

## Toestemming (opt-in)

Meta eist dat klanten toestemming hebben gegeven voor berichten van het bedrijf via WhatsApp. Voorstel: in de
offerte/akkoordtekst en in de algemene voorwaarden opnemen dat Gecko de klant over de opdracht informeert via
e-mail en WhatsApp, met de mogelijkheid af te melden (STOP). Zie ook docs/13 (privacyverklaring).

## Kosten

Meta rekent per gesprek: berichten binnen 24 uur na een bericht van de klant zijn gratis; sjablonen (Utility)
kosten enkele centen per bericht in Nederland. Actuele prijzen: developers.facebook.com/docs/whatsapp/pricing.
