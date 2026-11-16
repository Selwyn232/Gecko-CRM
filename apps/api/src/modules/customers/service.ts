import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { salesChannels } from "../catalog/schema.js";
import { emitEvent } from "../events/service.js";
import { journeyStatuses } from "../journeys/schema.js";
import { projects } from "../projects/schema.js";
import { customers, properties } from "./schema.js";

export const formatCustomerNumber = (n: number) => `K-${String(n).padStart(6, "0")}`;

/** "1234 ab" → "1234AB". Ongeldige Nederlandse postcodes worden geweigerd. */
export function normalizePostalCode(input: string, country = "NL") {
  const v = input.replace(/\s/g, "").toUpperCase();
  if (country === "NL" && !/^[1-9]\d{3}[A-Z]{2}$/.test(v)) throw badRequest("invalid_postal_code", "Ongeldige postcode");
  return v;
}

/** Telefoonnummer zonder spaties/streepjes; 06… → +316…, zodat zoeken en koppelen (WhatsApp, telefonie) werkt. */
export function normalizePhone(input: string | null | undefined) {
  if (!input) return null;
  let v = input.replace(/[\s\-().]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  else if (v.startsWith("0")) v = `+31${v.slice(1)}`;
  if (!/^\+\d{8,15}$/.test(v)) throw badRequest("invalid_phone", "Ongeldig telefoonnummer");
  return v;
}

const normalizeEmail = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : null);

export interface PropertyInput {
  street: string;
  houseNumber: string;
  houseNumberAddition?: string | null;
  postalCode: string;
  city: string;
  country?: string;
  bagId?: string | null;
  notes?: string | null;
}

export interface CustomerInput {
  firstName?: string | null;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  salesChannelId?: string | null;
  notes?: string | null;
}

function cleanProperty(p: PropertyInput) {
  const country = (p.country ?? "NL").toUpperCase();
  return {
    ...p,
    country,
    street: p.street.trim(),
    houseNumber: p.houseNumber.trim(),
    houseNumberAddition: p.houseNumberAddition?.trim() || null,
    city: p.city.trim(),
    postalCode: normalizePostalCode(p.postalCode, country),
  };
}

function cleanCustomer<T extends Partial<CustomerInput>>(c: T): T {
  const out = { ...c };
  if (c.email !== undefined) out.email = normalizeEmail(c.email);
  if (c.phone !== undefined) out.phone = normalizePhone(c.phone);
  return out;
}

export async function listCustomers(db: DbOrTx, q: { search?: string; limit: number; offset: number }) {
  const filters: SQL[] = [];
  if (q.search) {
    const s = q.search.trim();
    const like = `%${s}%`;
    const numeric = s.replace(/^k-?/i, "");
    const parts: SQL[] = [
      ilike(customers.lastName, like),
      ilike(customers.firstName, like),
      ilike(sql`${customers.firstName} || ' ' || ${customers.lastName}`, like),
      ilike(customers.email, like),
      inArray(
        customers.id,
        db
          .select({ id: properties.customerId })
          .from(properties)
          .where(or(ilike(properties.postalCode, `%${s.replace(/\s/g, "")}%`), ilike(properties.street, like), ilike(properties.city, like))),
      ),
    ];
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 6) parts.push(ilike(customers.phone, `%${digits.slice(-9)}%`));
    if (/^\d+$/.test(numeric)) parts.push(eq(customers.number, Number(numeric)));
    filters.push(or(...parts)!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db.select().from(customers).where(where).orderBy(desc(customers.createdAt)).limit(q.limit).offset(q.offset),
    db.select({ total: count() }).from(customers).where(where),
  ]);
  const ids = rows.map((r) => r.id);
  const props = ids.length ? await db.select().from(properties).where(inArray(properties.customerId, ids)) : [];
  const projectCounts = ids.length
    ? await db.select({ customerId: projects.customerId, n: count() }).from(projects).where(inArray(projects.customerId, ids)).groupBy(projects.customerId)
    : [];
  return {
    total,
    items: rows.map((c) => ({
      ...c,
      displayNumber: formatCustomerNumber(c.number),
      properties: props.filter((p) => p.customerId === c.id),
      projectCount: projectCounts.find((p) => p.customerId === c.id)?.n ?? 0,
    })),
  };
}

export async function getCustomer(db: DbOrTx, id: string) {
  const [c] = await db.select().from(customers).where(eq(customers.id, id));
  if (!c) throw notFound("Klant");
  const props = await db.select().from(properties).where(eq(properties.customerId, id)).orderBy(asc(properties.createdAt));
  const projs = await db
    .select({ project: projects, status: journeyStatuses })
    .from(projects)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, projects.statusId))
    .where(eq(projects.customerId, id))
    .orderBy(desc(projects.createdAt));
  return {
    ...c,
    displayNumber: formatCustomerNumber(c.number),
    properties: props,
    projects: projs.map((p) => ({ ...p.project, displayNumber: `P-${String(p.project.number).padStart(6, "0")}`, status: p.status })),
  };
}

export async function createCustomer(db: Db, actor: ActorContext, input: CustomerInput & { property?: PropertyInput }) {
  const { property, ...data } = input;
  return db.transaction(async (tx) => {
    if (data.salesChannelId) {
      const [ch] = await tx.select().from(salesChannels).where(eq(salesChannels.id, data.salesChannelId));
      if (!ch) throw badRequest("unknown_sales_channel", "Verkoopkanaal bestaat niet");
    }
    const [c] = await tx.insert(customers).values({ ...cleanCustomer(data), createdBy: actor.userId }).returning();
    await recordAudit(tx, actor, { action: "customer.created", entityType: "customer", entityId: c!.id, after: c });
    if (property) {
      const [p] = await tx.insert(properties).values({ ...cleanProperty(property), customerId: c!.id }).returning();
      await recordAudit(tx, actor, { action: "property.created", entityType: "customer", entityId: c!.id, after: p });
    }
    await emitEvent(tx, "customer.created", { type: "customer", id: c!.id }, { customerId: c!.id });
    return getCustomer(tx, c!.id);
  });
}

export async function updateCustomer(db: Db, actor: ActorContext, id: string, input: Partial<CustomerInput>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(customers).where(eq(customers.id, id));
    if (!before) throw notFound("Klant");
    const [after] = await tx.update(customers).set(cleanCustomer(input)).where(eq(customers.id, id)).returning();
    await recordAudit(tx, actor, { action: "customer.updated", entityType: "customer", entityId: id, before, after });
    return getCustomer(tx, id);
  });
}

export async function addProperty(db: Db, actor: ActorContext, customerId: string, input: PropertyInput) {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, customerId));
    if (!c) throw notFound("Klant");
    const [p] = await tx.insert(properties).values({ ...cleanProperty(input), customerId }).returning();
    await recordAudit(tx, actor, { action: "property.created", entityType: "customer", entityId: customerId, after: p });
    return p!;
  });
}

export async function updateProperty(db: Db, actor: ActorContext, id: string, input: Partial<PropertyInput>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(properties).where(eq(properties.id, id));
    if (!before) throw notFound("Woning");
    const merged = cleanProperty({ ...before, ...input } as PropertyInput);
    const [after] = await tx.update(properties).set(merged).where(eq(properties.id, id)).returning();
    await recordAudit(tx, actor, { action: "property.updated", entityType: "customer", entityId: before.customerId, before, after });
    return after!;
  });
}
