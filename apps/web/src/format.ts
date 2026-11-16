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
