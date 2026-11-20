import { useQuery } from "@tanstack/react-query";
import { api, type Organization, type ProductGroup, type Role, type SalesChannel, type User, type VatCode } from "./api";

/** Gedeelde referentiedata, één keer opgehaald en gecachet. */
export const useProductGroups = () => useQuery({ queryKey: ["product-groups"], queryFn: () => api.get<ProductGroup[]>("/product-groups") });
export const useChannels = () => useQuery({ queryKey: ["sales-channels"], queryFn: () => api.get<SalesChannel[]>("/sales-channels") });
export const useOrganizations = (enabled = true) =>
  useQuery({ queryKey: ["organizations"], queryFn: () => api.get<Organization[]>("/organizations"), enabled });
export const useVatCodes = () => useQuery({ queryKey: ["vat-codes"], queryFn: () => api.get<VatCode[]>("/vat-codes") });
export const useRoles = () => useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });

export const nameById = <T extends { id: string; name: string }>(list: T[] | undefined, id: string | null | undefined) =>
  list?.find((x) => x.id === id)?.name ?? "—";

import type { JourneyStatus, ProductGroup as PG } from "./api";
export const useJourneys = () =>
  useQuery({ queryKey: ["journeys"], queryFn: () => api.get<Journey[]>("/journeys") });

/** Klantreis = productgroep + verkoopkanaal (leeg = standaard, B80). */
export interface Journey {
  productGroup: PG;
  salesChannel: { id: string; name: string } | null;
  channels: { id: string; name: string }[];
  statuses: JourneyStatus[];
}

import type { Advisor } from "./api";
export const useAdvisors = (organizationId?: string | null) =>
  useQuery({
    queryKey: ["advisors", organizationId ?? "all"],
    queryFn: () => api.get<Advisor[]>(`/advisors${organizationId ? `?organizationId=${organizationId}` : ""}`),
    enabled: organizationId !== null,
  });

/** Actieve installatiepartners die deze productgroep installeren (zonder ingestelde productgroepen: alle). */
export const partnersFor = (orgs: Organization[] | undefined, productGroupId: string | null | undefined) =>
  (orgs ?? []).filter(
    (o) => o.type === "installation_partner" && o.isActive && (!productGroupId || !o.productGroupIds?.length || o.productGroupIds.includes(productGroupId)),
  );
