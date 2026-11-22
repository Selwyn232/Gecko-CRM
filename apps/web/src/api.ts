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
  organizationType: string | null;
  organizationName: string | null;
  /** Gevuld als een beheerder via "Inloggen als" meekijkt. */
  impersonatedBy: { id: string; name: string } | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  /** Ingestelde 2FA-methode. */
  mfaMethod?: "totp" | "sms" | "passkey" | null;
  /** Mag 2FA via sms kiezen (recht én sms ingesteld). */
  smsAllowed?: boolean;
  /** Gemaskeerd nummer voor sms-codes, bv. "06 ••••• 678". */
  smsPhone?: string | null;
  /** Heeft een passkey (Face ID e.d.). */
  hasPasskey?: boolean;
  /** Domein waarop passkeys werken. */
  passkeyDomain?: string;
  permissions: string[];
}
export interface Organization {
  id: string;
  name: string;
  type: "gecko" | "sales_partner" | "installation_partner" | "supplier";
  kvkNumber: string | null;
  vatNumber: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  selfBillingPrefix?: string | null;
  selfBillingVatMode?: "normal" | "reverse_charge" | null;
  crewCount?: number;
  isActive: boolean;
  /** Installatiepartner: productgroepen die hij installeert (leeg = nog niet ingesteld = alle). */
  productGroupIds?: string[];
  /** Aantal actieve gebruikers (accounts) van deze organisatie. */
  userCount?: number;
}
export interface Invite {
  url: string;
  emailStatus: string;
  email: string;
}
export interface ProductGroup {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  installationDays: number;
  isActive: boolean;
}
export interface SalesChannel {
  id: string;
  key: string;
  name: string;
  salesPartnerOrganizationId: string | null;
  feeBasisPoints: number | null;
  quoteValidityDays: number;
  installationLeadDays?: number | null;
  isActive: boolean;
  productGroupIds: string[];
  /** Fee per productgroep (basispunten); null = fee van het kanaal. */
  groupFees?: Record<string, number | null>;
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
  salesChannelId?: string | null;
  key: string;
  name: string;
  phase: string;
  sortOrder: number;
  isInitial: boolean;
  isFinal: boolean;
  color: string;
  isActive: boolean;
  invoiceTrigger?: "deposit" | "final" | null;
  autoOnEvents?: string[];
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
  specialist: { id: string; name: string; email: string | null; hasPhoto: boolean } | null;
  serviceSince: string | null;
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

export type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "superseded" | "expired";
export interface Advisor {
  id: string;
  organizationId: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
}
export interface QuoteLine {
  id: string;
  productId: string;
  productCode: string;
  productType: string;
  unit: string;
  description: string;
  quantity: string;
  unitPriceCents: number;
  vatRateBasisPoints: number;
  unitCostCents: number | null;
  lineTotalCents: number;
}
export interface QuoteTotals {
  subtotalCents: number;
  vat: { rateBasisPoints: number; baseCents: number; vatCents: number }[];
  vatCents: number;
  totalCents: number;
}
export interface Quote {
  id: string;
  displayNumber: string;
  status: Exclude<QuoteStatus, "expired">;
  effectiveStatus: QuoteStatus;
  customerId: string;
  propertyId: string;
  productGroupId: string;
  salesChannelId: string;
  advisorId: string | null;
  installationPartnerId: string | null;
  priceDate: string | null;
  validUntil: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  acceptedByName: string | null;
  acceptanceMethod: string | null;
  rejectionReason: string | null;
  supersedesQuoteId: string | null;
  projectId: string | null;
  customerNote: string | null;
  internalNote: string | null;
  acceptanceEvidence: Record<string, unknown> | null;
  createdAt: string;
  customer: CustomerSummary;
  property: Property;
  salesChannel: SalesChannel;
  productGroup: ProductGroup;
  advisor: Advisor | null;
  lines: QuoteLine[];
  totals: QuoteTotals;
  margin: { costCents: number | null; feeCents: number | null; marginCents: number | null; marginBasisPoints: number | null; complete: boolean } | null;
}
export interface QuoteListItem {
  id: string;
  displayNumber: string;
  effectiveStatus: QuoteStatus;
  productGroupId: string;
  validUntil: string | null;
  createdAt: string;
  projectId: string | null;
  customer: { id: string; firstName: string | null; lastName: string; displayNumber: string };
  property: Property;
  totals: QuoteTotals;
}

export type InvoiceType = "deposit" | "final" | "credit";
export type InvoiceStatus = "draft" | "open" | "paid" | "credited";
export interface InvoiceLine {
  id: string;
  productCode: string | null;
  description: string;
  quantity: string;
  unitPriceCents: number;
  vatRateBasisPoints: number;
  lineTotalCents: number;
}
export interface Payment {
  id: string;
  amountCents: number;
  method: string;
  status: string;
  provider: string | null;
  paidAt: string | null;
  note: string | null;
  createdAt: string;
}
export interface InvoiceSummary {
  id: string;
  number: string | null;
  type: InvoiceType;
  status: InvoiceStatus;
  projectId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
  dunningStage: "none" | "reminder" | "formal_notice" | "collection";
  dunningPaused: string | null;
  customer: { id: string; firstName: string | null; lastName: string; displayNumber: string } | null;
}
export interface InvoiceDetail extends InvoiceSummary {
  subtotalCents: number;
  vatCents: number;
  vatBreakdown: { rateBasisPoints: number; baseCents: number; vatCents: number }[];
  paymentReference: string | null;
  customerSnapshot: { name: string; customerNumber: string; email: string | null; address: { street: string; houseNumber: string; houseNumberAddition: string | null; postalCode: string; city: string } | null } | null;
  companySnapshot: Organization | null;
  note: string | null;
  creditedInvoiceId: string | null;
  sentAt: string | null;
  paidAt: string | null;
  lines: InvoiceLine[];
  payments: Payment[];
  dunning: { id: string; stage: string; outstandingCents: number; collectionCostsCents: number | null; deadline: string | null; createdAt: string }[];
  emails: { id: string; toAddress: string; template: string; status: string; error: string | null; createdAt: string }[];
}

export interface Region {
  id: string;
  name: string;
  mapCode: string | null;
  postalRanges: [number, number][];
  isActive: boolean;
}
export type DayPart = "morning" | "afternoon";
export interface AvailabilityBlock {
  partnerOrganizationId: string;
  date: string;
  part: DayPart;
  /** Gevuld als er een afspraak in dit blok staat. */
  appointmentId: string | null;
  /** Aantal afspraken en ploegen (capaciteit) in dit dagdeel. */
  appointmentCount?: number;
  capacity?: number;
}
export interface Appointment {
  id: string;
  projectId: string;
  projectNumber: string;
  partnerOrganizationId: string;
  partnerName: string;
  regionName: string;
  productGroupName: string;
  type: "survey" | "installation";
  date: string;
  days: number;
  timeWindow: "morning" | "afternoon" | "day";
  status: "planned" | "completed" | "canceled" | "partner_no_show";
  notes: string | null;
  cancelReason: string | null;
  address: string;
  customer: { id: string; firstName: string | null; lastName: string; email: string | null; phone: string | null };
  report: { id: string; review: "pending" | "approved" | "rejected"; positive: boolean; submittedAt: string } | null;
  /** Geplande schouw waarvoor de aanbetaling nog niet is betaald. */
  depositUnpaid?: boolean;
}
export interface Penalty {
  id: string;
  partnerOrganizationId: string;
  partnerName: string;
  appointmentId: string | null;
  amountCents: number;
  reason: string;
  status: "open" | "settled" | "waived";
  waivedReason: string | null;
  createdAt: string;
}
export interface ReportData {
  remarks?: string;
  checklist?: Record<string, boolean>;
  serialNumbers?: string[];
  extraWork?: { productId: string; quantity: number; note?: string }[];
}
export interface Report {
  id: string;
  appointmentId: string;
  type: "survey" | "installation";
  positive: boolean;
  data: ReportData;
  customerSignedName: string | null;
  customerSignatureFileId: string | null;
  submittedAt: string;
  review: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  appointment: Appointment;
  files?: { id: string; filename: string; contentType: string }[];
}
export interface ToPlanItem {
  projectId: string;
  projectNumber: string;
  customerName: string;
  postalCode: string;
  city: string;
  productGroupName: string;
  statusName: string;
  waitingSince: string;
}
