/**
 * Alle rechten in het systeem. Rechten staan vast in code, omdat de code ze afdwingt;
 * welke rol welke rechten heeft is door beheerders in te stellen.
 *
 * Nieuw recht toevoegen: zet het hier, gebruik het in een route met `requirePermission`,
 * en ken het toe via het rollenbeheer (of in de seed voor standaardrollen).
 */
export const PERMISSIONS = {
  "users.read": "Gebruikers bekijken",
  "users.manage": "Gebruikers aanmaken, wijzigen en blokkeren",
  "roles.manage": "Rollen en rechten beheren",
  "organizations.read": "Organisaties bekijken",
  "organizations.manage": "Organisaties beheren",
  "audit.read": "Wijzigingslogboek bekijken",
  "catalog.read": "Producten, productgroepen en verkoopprijzen bekijken",
  "catalog.manage": "Producten, productgroepen, kanalen en stuklijsten beheren",
  "sales_prices.manage": "Verkoopprijzen beheren",
  "purchase_prices.read": "Inkoopprijzen en partnertarieven bekijken",
  "purchase_prices.manage": "Inkoopprijzen en partnertarieven beheren",
  "settings.manage": "Systeeminstellingen beheren (o.a. btw-tarieven)",
  "customers.read": "Klanten en woningen bekijken",
  "customers.manage": "Klanten en woningen aanmaken en wijzigen",
  "projects.read": "Projecten en hun status bekijken",
  "projects.manage": "Projecten aanmaken, wijzigen en status aanpassen",
  "journeys.manage": "Klantreizen (statussen en overgangen) instellen",
  "quotes.read": "Offertes bekijken",
  "quotes.manage": "Offertes maken, versturen en akkoord registreren",
  "invoices.read": "Facturen en betalingen bekijken",
  "planning.read": "Planning en afspraken bekijken",
  "planning.manage": "Afspraken plannen, regio's en beschikbaarheid beheren, rapporten beoordelen",
  "partner.portal": "Partnerportaal (alleen eigen afspraken, beschikbaarheid en rapporten)",
  "invoices.manage": "Facturen maken, crediteren, betalingen registreren en aanmaningen beheren",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const isPermission = (value: string): value is Permission => value in PERMISSIONS;

/** Sleutel van de systeemrol die altijd alle rechten heeft. */
export const ADMIN_ROLE_KEY = "beheerder";
