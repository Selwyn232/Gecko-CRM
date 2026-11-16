/**
 * Invulvelden, vaste berichtmomenten en standaardteksten voor klantberichten.
 * Teksten zijn platte tekst: een lege regel = nieuwe alinea. Invulvelden tussen accolades, bv. {voornaam}.
 */

export const PLACEHOLDERS = {
  voornaam: "Voornaam klant (of achternaam als die ontbreekt)",
  achternaam: "Achternaam klant",
  naam: "Volledige naam klant",
  projectnummer: "Projectnummer",
  productgroep: "Productgroep, bv. thuisbatterij",
  adres: "Adres van de woning",
  status: "Naam van de status",
  bedrijf: "Naam van Gecko",
  afspraak_soort: "schouw of installatie (eerstvolgende afspraak)",
  afspraak_datum: "Datum van de afspraak, bv. dinsdag 17 november 2026",
  dagdeel: "in de ochtend (8:00–12:00), in de middag (12:00–17:00) of gedurende de dag",
  aantal_dagen: "Aantal dagen van de installatie",
  partner: "Naam van de installatiepartner",
} as const;

export type PlaceholderKey = keyof typeof PLACEHOLDERS;
export type MessageVars = Partial<Record<PlaceholderKey, string>>;

/** Vaste momenten die niet aan een status hangen. */
export const FIXED_MESSAGES = {
  "appointment.scheduled.survey": {
    label: "Schouw ingepland",
    when: "Direct na het inplannen of verzetten van de schouw",
    subject: "Uw schouw is ingepland op {afspraak_datum}",
    body: `Beste {naam},

De schouw voor uw {productgroep} is ingepland op {afspraak_datum}, {dagdeel}.

Adres: {adres}
Uitgevoerd door: {partner}

Tijdens de schouw bekijkt de installateur de situatie in uw woning en bespreekt de installatie met u. Zorgt u ervoor dat er iemand thuis is?

Komt deze datum niet uit? Beantwoord dan deze e-mail.`,
  },
  "appointment.scheduled.installation": {
    label: "Installatie ingepland",
    when: "Direct na het inplannen of verzetten van de installatie",
    subject: "Uw installatie is ingepland op {afspraak_datum}",
    body: `Beste {naam},

De installatie van uw {productgroep} is ingepland op {afspraak_datum}, {dagdeel} ({aantal_dagen} dag(en)).

Adres: {adres}
Uitgevoerd door: {partner}

Komt deze datum niet uit? Beantwoord dan deze e-mail.`,
  },
  "appointment.canceled": {
    label: "Afspraak gaat niet door",
    when: "Bij het annuleren van een schouw of installatie (als 'klant informeren' aan staat)",
    subject: "Uw {afspraak_soort} op {afspraak_datum} gaat niet door",
    body: `Beste {naam},

De {afspraak_soort} op {afspraak_datum} gaat helaas niet door. Wij nemen contact met u op voor een nieuwe afspraak.`,
  },
  "appointment.reminder.survey": {
    label: "Herinnering schouw",
    when: "De dag vóór de schouw, vanaf 9:00 uur",
    subject: "Herinnering: morgen uw schouw",
    body: `Beste {naam},

Morgen, {afspraak_datum}, komt {partner} {dagdeel} voor de schouw van uw {productgroep}.

Adres: {adres}

Zorgt u ervoor dat er iemand thuis is en dat de meterkast en de plek van de installatie goed bereikbaar zijn? Lukt het onverhoopt niet? Beantwoord dan zo snel mogelijk deze e-mail.`,
  },
  "appointment.reminder.installation": {
    label: "Herinnering installatie",
    when: "De dag vóór (de eerste dag van) de installatie, vanaf 9:00 uur",
    subject: "Herinnering: morgen de installatie van uw {productgroep}",
    body: `Beste {naam},

Morgen, {afspraak_datum}, start {partner} met de installatie van uw {productgroep}.

Adres: {adres}

Zorgt u ervoor dat er iemand thuis is en dat de plek van de installatie vrij en goed bereikbaar is? Na afloop vraagt de installateur u om de oplevering te tekenen.`,
  },
} as const;

export type FixedMessageKey = keyof typeof FIXED_MESSAGES;
export const FIXED_KEYS = Object.keys(FIXED_MESSAGES) as FixedMessageKey[];

/**
 * Standaardberichten per status van de standaard-klantreis (journeys/defaults.ts).
 * Statussen die al een eigen e-mail hebben (offertebevestiging, afspraak, meerwerk-offerte, factuur) staan hier niet.
 */
export const DEFAULT_STATUS_MESSAGES: Record<string, { subject: string; body: string; isActive: boolean }> = {
  schouw_inplannen: {
    isActive: true,
    subject: "We plannen uw schouw in",
    body: `Beste {naam},

Bedankt voor uw opdracht voor een {productgroep}. De eerste stap is de schouw: een installateur komt bij u langs om de situatie te bekijken.

Wij plannen de schouw nu in. U ontvangt binnen enkele werkdagen een e-mail met de datum.

Uw projectnummer is {projectnummer}.`,
  },
  wacht_financiering: {
    isActive: false,
    subject: "Wij wachten op uw financiering",
    body: `Beste {naam},

Wij hebben uw opdracht voor een {productgroep} ontvangen. Zodra uw financiering rond is, plannen wij de schouw in.

Uw projectnummer is {projectnummer}.`,
  },
  aanbetaling_ontvangen: {
    isActive: true,
    subject: "Uw aanbetaling is ontvangen",
    body: `Beste {naam},

Wij hebben uw aanbetaling ontvangen, dank u wel. De schouw gaat door zoals gepland.`,
  },
  installatie_inplannen: {
    isActive: true,
    subject: "We plannen uw installatie in",
    body: `Beste {naam},

De schouw is afgerond en goedgekeurd. Wij plannen nu de installatie van uw {productgroep} in. U ontvangt hierover binnenkort een e-mail met de datum.`,
  },
  oplevering_controle: {
    isActive: true,
    subject: "Uw {productgroep} is geïnstalleerd",
    body: `Beste {naam},

De installatie van uw {productgroep} is afgerond. Wij controleren nog het opleverrapport. Daarna ontvangt u de eindfactuur.

Heeft u vragen over de installatie? Beantwoord dan deze e-mail.`,
  },
  afgerond: {
    isActive: true,
    subject: "Uw project is afgerond",
    body: `Beste {naam},

Uw project {projectnummer} is afgerond. Bedankt voor uw vertrouwen in {bedrijf}.

Heeft u in de toekomst vragen over uw {productgroep}? Beantwoord dan deze e-mail; wij helpen u graag.`,
  },
  geannuleerd: {
    isActive: false,
    subject: "Uw project is geannuleerd",
    body: `Beste {naam},

Hierbij bevestigen wij dat uw project {projectnummer} voor een {productgroep} is geannuleerd.

Heeft u hier vragen over? Beantwoord dan deze e-mail.`,
  },
};

/** Vervangt {invulvelden}. Onbekende of lege velden worden een lege tekst. */
export function fill(text: string, vars: MessageVars) {
  return text.replace(/\{([a-z_]+)\}/g, (m, key: string) => (key in PLACEHOLDERS ? (vars[key as PlaceholderKey] ?? "") : m));
}

/** Invulvelden die in de tekst staan maar niet bestaan (voor een duidelijke melding bij opslaan). */
export function unknownPlaceholders(text: string) {
  return [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!).filter((k) => !(k in PLACEHOLDERS)))];
}

/** Voorbeeldwaarden voor de voorvertoning en testmail. */
export const SAMPLE_VARS: Required<MessageVars> = {
  voornaam: "Anna",
  achternaam: "de Boer",
  naam: "Anna de Boer",
  projectnummer: "P-000123",
  productgroep: "thuisbatterij",
  adres: "Dorpsstraat 1, 1234 AB Voorbeeld",
  status: "Schouw in te plannen",
  bedrijf: "Gecko BV",
  afspraak_soort: "schouw",
  afspraak_datum: "dinsdag 17 november 2026",
  dagdeel: "in de ochtend (8:00–12:00)",
  aantal_dagen: "1",
  partner: "Installatiebedrijf Voorbeeld",
};
