import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AuditEntry } from "../api";
import { Loading, PageHead } from "../components/ui";
import { formatCents, formatDateTime } from "../format";
import { nameById, useUsers } from "../hooks";

const ACTIONS: Record<string, string> = {
  "auth.login": "Ingelogd",
  "auth.login_failed": "Mislukte inlogpoging",
  "auth.account_locked": "Account geblokkeerd",
  "auth.mfa_enabled": "2FA ingesteld",
  "auth.mfa_verified": "2FA geverifieerd",
  "auth.password_changed": "Wachtwoord gewijzigd",
  "user.created": "Gebruiker aangemaakt",
  "user.updated": "Gebruiker gewijzigd",
  "user.password_reset": "Wachtwoord gereset",
  "user.mfa_reset": "2FA gereset",
  "user.unlocked": "Gedeblokkeerd",
  "role.created": "Rol aangemaakt",
  "role.updated": "Rol gewijzigd",
  "role.deleted": "Rol verwijderd",
  "organization.created": "Organisatie aangemaakt",
  "organization.updated": "Organisatie gewijzigd",
  "product.created": "Product aangemaakt",
  "product.updated": "Product gewijzigd",
  "product.bom_replaced": "Stuklijst gewijzigd",
  "price.sales.created": "Verkoopprijs toegevoegd",
  "price.sales.deleted": "Verkoopprijs verwijderd",
  "price.purchase.created": "Inkoopprijs toegevoegd",
  "price.purchase.deleted": "Inkoopprijs verwijderd",
  "price.partner.created": "Partnertarief toegevoegd",
  "price.partner.deleted": "Partnertarief verwijderd",
  "sales_channel.created": "Kanaal aangemaakt",
  "sales_channel.updated": "Kanaal gewijzigd",
  "product_group.created": "Productgroep aangemaakt",
  "product_group.updated": "Productgroep gewijzigd",
  "vat_rate.created": "Btw-tarief toegevoegd",
  "customer.created": "Klant aangemaakt",
  "customer.updated": "Klant gewijzigd",
  "property.created": "Woning toegevoegd",
  "property.updated": "Woning gewijzigd",
  "project.created": "Project aangemaakt",
  "project.updated": "Project gewijzigd",
  "project.status_changed": "Status gewijzigd",
  "journey_status.created": "Status aangemaakt",
  "journey_status.updated": "Status gewijzigd",
  "journey_status.deleted": "Status verwijderd",
  "journey_status.transitions_set": "Overgangen gewijzigd",
  "quote.created": "Offerte aangemaakt",
  "quote.updated": "Offerte gewijzigd",
  "quote.line_added": "Offerteregel toegevoegd",
  "quote.line_updated": "Offerteregel gewijzigd",
  "quote.line_removed": "Offerteregel verwijderd",
  "quote.sent": "Offerte definitief gemaakt",
  "quote.accepted": "Offerte geaccepteerd",
  "quote.rejected": "Offerte afgewezen",
  "quote.revised": "Nieuwe offerteversie",
  "quote.link_sent": "Offerte ter akkoord verstuurd",
  "advisor.created": "Adviseur toegevoegd",
  "advisor.updated": "Adviseur gewijzigd",
};

const FIELD_LABELS: Record<string, string> = {
  name: "Naam", email: "E-mail", isActive: "Actief", roleIds: "Rollen", organizationId: "Organisatie",
  priceCents: "Prijs", validFrom: "Ingangsdatum", scopeId: "Kanaal/leverancier/partner", code: "Code",
  type: "Type", vatCode: "Btw", unit: "Eenheid", description: "Omschrijving", permissions: "Rechten",
  productGroupIds: "Productgroepen", bom: "Stuklijst", mfaEnabled: "2FA", status: "Status", firstName: "Voornaam",
  lastName: "Achternaam", phone: "Telefoon", street: "Straat", houseNumber: "Huisnummer", postalCode: "Postcode", city: "Plaats",
  installationPartnerId: "Installatiepartner", validUntil: "Geldig tot", quantity: "Aantal", acceptedByName: "Akkoord door", method: "Wijze", reason: "Reden", feeBasisPoints: "Fee", advisorId: "Adviseur", customerNote: "Tekst klant", internalNote: "Interne notitie", paymentMethod: "Betaalwijze", next: "Vervolgstatussen", phase: "Fase", mfaRequired: "2FA verplicht", username: "Gebruikersnaam",
};
/** Technische velden die in het logboek niets toevoegen. */
const HIDDEN = new Set(["id", "productId", "createdAt", "createdBy", "lastLoginAt", "lockedUntil", "number", "customerId", "statusChangedAt", "statusId", "propertyId", "productGroupId", "salesChannelId", "country", "sortOrder"]);
const ENTITY: Record<string, string> = { quote: "Offerte", customer: "Klant", project: "Project", journey_status: "Klantreis", user: "Gebruiker", role: "Rol", organization: "Organisatie", product: "Product", sales_channel: "Kanaal", product_group: "Productgroep", vat_code: "Btw" };

const show = (key: string, v: unknown) => {
  if (v === null || v === undefined || v === "") return "—";
  if (key.endsWith("Cents") && typeof v === "number") return formatCents(v);
  if (typeof v === "boolean") return v ? "ja" : "nee";
  if (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) return v.slice(0, 8);
  if (Array.isArray(v)) return `${v.length} item(s)`;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

export function AuditPage() {
  const users = useUsers();
  const [entityType, setEntityType] = useState("");
  const log = useInfiniteQuery({
    queryKey: ["audit", entityType],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "50" });
      if (entityType) p.set("entityType", entityType);
      if (pageParam) p.set("before", String(pageParam));
      return api.get<{ items: AuditEntry[]; nextCursor: number | null }>(`/audit-log?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHead title="Logboek" sub="Elke wijziging in het systeem: wie, wat en wanneer. Kan door niemand worden aangepast." />
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          <option value="">Alles</option>
          <option value="customer">Klanten</option>
          <option value="quote">Offertes</option>
          <option value="project">Projecten</option>
          <option value="journey_status">Klantreizen</option>
          <option value="user">Gebruikers</option>
          <option value="role">Rollen</option>
          <option value="organization">Organisaties</option>
          <option value="product">Producten &amp; prijzen</option>
          <option value="sales_channel">Verkoopkanalen</option>
        </select>
      </div>
      <div className="card flush">
        {log.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th style={{ width: 140 }}>Tijdstip</th><th>Door</th><th>Onderwerp</th><th>Actie</th><th>Wijzigingen</th></tr></thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{formatDateTime(e.occurredAt)}</td>
                  <td>{e.actorUserId ? nameById(users.data, e.actorUserId) : <span className="muted">Systeem</span>}</td>
                  <td className="muted">{ENTITY[e.entityType] ?? e.entityType}</td>
                  <td>{ACTIONS[e.action] ?? e.action}</td>
                  <td style={{ fontSize: 13 }}>
                    {e.changes && Object.keys(e.changes).length > 0
                      ? Object.entries(e.changes).filter(([k]) => !HIDDEN.has(k)).slice(0, 8).map(([k, c]) => (
                          <div key={k}>
                            <span className="muted">{FIELD_LABELS[k] ?? k}:</span>{" "}
                            {c.from === null || c.from === undefined ? <strong>{show(k, c.to)}</strong> : <>{show(k, c.from)} → <strong>{show(k, c.to)}</strong></>}
                          </div>
                        ))
                      : e.metadata ? <span className="muted">{Object.entries(e.metadata).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {log.hasNextPage && <button className="btn" onClick={() => void log.fetchNextPage()}>Meer laden</button>}
    </>
  );
}
