/** Dunne laag rond fetch. Alle API-aanroepen gaan hierlangs; fouten worden ApiError met code en melding. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "Er ging iets mis");
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---- Types (spiegelen de API) ----
export interface Me {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  mustChangePassword: boolean;
  organizationId: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  permissions: string[];
}
export interface Organization {
  id: string;
  name: string;
  type: "gecko" | "sales_partner" | "installation_partner" | "supplier";
  kvkNumber: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}
export interface ProductGroup {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}
export interface SalesChannel {
  id: string;
  key: string;
  name: string;
  salesPartnerOrganizationId: string | null;
  isActive: boolean;
  productGroupIds: string[];
}
export type ProductType = "package" | "component" | "labor" | "extra_work" | "service";
export interface Product {
  id: string;
  code: string;
  name: string;
  description: string | null;
  productGroupId: string;
  type: ProductType;
  unit: string;
  vatCode: string;
  defaultSupplierOrganizationId: string | null;
  isActive: boolean;
}
export interface BomLine {
  id: string;
  componentProductId: string;
  quantity: string;
  code: string;
  name: string;
  type: ProductType;
}
export interface PriceVersion {
  id: string;
  productId: string;
  scopeId: string;
  priceCents: number;
  validFrom: string;
  createdAt: string;
}
export interface VatCode {
  code: string;
  name: string;
  currentRateBasisPoints: number | null;
}
export interface User {
  id: string;
  organizationId: string;
  email: string | null;
  username: string | null;
  name: string;
  mfaRequired: boolean;
  mustChangePassword: boolean;
  isActive: boolean;
  mfaEnabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  roleIds: string[];
}
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount?: number;
}
export interface AuditEntry {
  id: number;
  occurredAt: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  metadata: Record<string, unknown> | null;
}
export interface Cost {
  lines: {
    productId: string;
    code: string;
    name: string;
    quantity: string;
    source: string | null;
    unitCostCents: number | null;
    totalCents: number | null;
  }[];
  totalCents: number;
  complete: boolean;
  missingPrices: string[];
}

export interface Property {
  id: string;
  customerId: string;
  street: string;
  houseNumber: string;
  houseNumberAddition: string | null;
  postalCode: string;
  city: string;
  country: string;
  notes: string | null;
}
export interface JourneyStatus {
  id: string;
  productGroupId: string;
  key: string;
  name: string;
  phase: string;
  sortOrder: number;
  isInitial: boolean;
  isFinal: boolean;
  color: string;
  isActive: boolean;
  nextStatusIds?: string[];
  projectCount?: number;
}
export interface CustomerSummary {
  id: string;
  number: number;
  displayNumber: string;
  firstName: string | null;
  lastName: string;
  email: string | null;
  phone: string | null;
  salesChannelId: string | null;
  notes: string | null;
  createdAt: string;
  properties: Property[];
  projectCount?: number;
}
export interface ProjectSummary {
  id: string;
  displayNumber: string;
  customerId: string;
  propertyId: string;
  productGroupId: string;
  salesChannelId: string;
  statusId: string;
  statusChangedAt: string;
  installationPartnerId: string | null;
  paymentMethod: "direct" | "warmtefonds";
  notes: string | null;
  createdAt: string;
  status: JourneyStatus;
}
export interface CustomerDetail extends CustomerSummary {
  projects: ProjectSummary[];
}
export interface ProjectListItem extends ProjectSummary {
  customer: { id: string; displayNumber: string; firstName: string | null; lastName: string };
  property: Property;
}
export interface ProjectDetail extends ProjectSummary {
  customer: CustomerSummary;
  property: Property;
  history: { id: string; fromStatusId: string | null; toStatusId: string; changedAt: string; changedByName: string | null; note: string | null }[];
  nextStatuses: JourneyStatus[];
}
export interface Paged<T> {
  total: number;
  items: T[];
}
