const eur = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });

export const formatCents = (cents: number | null | undefined) => (cents == null ? "—" : eur.format(cents / 100));

/** Accepteert "1.234,56", "1234,56" en "1234.56". Geeft centen of null bij ongeldige invoer. */
export function parseEuro(input: string): number | null {
  let s = input.trim().replace(/[€\s]/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("nl-NL") : "—";

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" }) : "—";

export const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());

export const PRODUCT_TYPES: Record<string, string> = {
  package: "Pakket",
  component: "Component",
  labor: "Arbeid",
  extra_work: "Meerwerk",
  service: "Dienst",
};

export const ORG_TYPES: Record<string, string> = {
  gecko: "Gecko",
  sales_partner: "Verkooppartner",
  installation_partner: "Installatiepartner",
  supplier: "Leverancier",
};

export const customerName = (c: { firstName: string | null; lastName: string }) => [c.firstName, c.lastName].filter(Boolean).join(" ");

export const formatAddress = (p: { street: string; houseNumber: string; houseNumberAddition: string | null; postalCode: string; city: string }) =>
  `${p.street} ${p.houseNumber}${p.houseNumberAddition ? `-${p.houseNumberAddition}` : ""}, ${p.postalCode.replace(/^(\d{4})([A-Z]{2})$/, "$1 $2")} ${p.city}`;

export const PAYMENT_METHODS: Record<string, string> = { direct: "Direct (iDEAL/overschrijving)", warmtefonds: "Warmtefonds" };

export const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

export const QUOTE_STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: "Concept", color: "gray" },
  sent: { label: "Verstuurd", color: "blue" },
  accepted: { label: "Geaccepteerd", color: "green" },
  rejected: { label: "Afgewezen", color: "red" },
  superseded: { label: "Vervangen", color: "gray" },
  expired: { label: "Verlopen", color: "yellow" },
};

export const ACCEPTANCE_METHODS: Record<string, string> = {
  signed_paper: "Getekend op papier",
  signed_digital: "Digitaal getekend",
  email: "Akkoord per e-mail",
  verbal_confirmed: "Mondeling, schriftelijk bevestigd",
};

export const formatPercent = (bp: number | null | undefined) =>
  bp == null ? "—" : `${(bp / 100).toLocaleString("nl-NL", { maximumFractionDigits: 1 })}%`;

export const formatQty = (q: string | number) => Number(q).toLocaleString("nl-NL", { maximumFractionDigits: 3 });
