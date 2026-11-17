import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { productGroups, salesChannels } from "../catalog/schema.js";
import { customers, properties } from "../customers/schema.js";
import { addProperty, createCustomer, formatCustomerNumber, normalizePostalCode } from "../customers/service.js";
import { files } from "../files/schema.js";
import { MAX_FILE_BYTES, saveFile } from "../files/storage.js";
import { advisors } from "../organizations/schema.js";
import { users } from "../auth/schema.js";
import { isGreenteamQuote, parseGreenteamQuote, type ParsedGreenteamQuote } from "./greenteam.js";
import { extractPdfText } from "./pdf.js";
import { externalQuotes } from "./schema.js";

const SOURCE = "greenteam";

async function readPdf(dataBase64: string) {
  const buf = Buffer.from(dataBase64, "base64");
  if (!buf.length) throw badRequest("file_empty", "Leeg bestand");
  if (buf.length > MAX_FILE_BYTES) throw badRequest("file_too_large", "Bestand is te groot (max 8 MB)");
  if (buf.subarray(0, 5).toString() !== "%PDF-") throw badRequest("not_pdf", "Dit is geen PDF-bestand");
  let pages;
  try {
    pages = await extractPdfText(buf);
  } catch {
    throw badRequest("pdf_unreadable", "De PDF kan niet worden gelezen");
  }
  if (!isGreenteamQuote(pages)) {
    throw badRequest("not_greenteam_quote", "Dit lijkt geen offerte van Greenteam (geen pagina met 'Offerte #' en 'Gegevens aanvrager' gevonden)");
  }
  return parseGreenteamQuote(pages);
}

/** Het verkoopkanaal en de organisatie van Greenteam (kanaalsleutel "greenteam"). */
async function greenteam(db: DbOrTx) {
  const [ch] = await db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
  return { channelId: ch?.id ?? null, organizationId: ch?.salesPartnerOrganizationId ?? null };
}

async function findAdvisor(db: DbOrTx, organizationId: string | null, a: ParsedGreenteamQuote["advisor"]) {
  if (!organizationId || (!a.name && !a.email)) return null;
  const rows = await db.select().from(advisors).where(eq(advisors.organizationId, organizationId));
  return (
    rows.find((r) => a.email && r.email?.toLowerCase() === a.email) ??
    rows.find((r) => a.name && r.name.trim().toLowerCase() === a.name.trim().toLowerCase()) ??
    null
  );
}

/** Bestaande klant: eerst op e-mailadres, dan op postcode + huisnummer. */
async function findCustomer(db: DbOrTx, c: ParsedGreenteamQuote["customer"]) {
  if (c.email) {
    const [m] = await db.select().from(customers).where(sql`lower(${customers.email}) = ${c.email.toLowerCase()}`).limit(1);
    if (m) return { customer: m, matchedOn: "e-mailadres" as const };
  }
  if (c.postalCode && c.houseNumber) {
    const [m] = await db
      .select({ customer: customers })
      .from(properties)
      .innerJoin(customers, eq(customers.id, properties.customerId))
      .where(and(eq(properties.postalCode, normalizePostalCode(c.postalCode)), eq(properties.houseNumber, c.houseNumber)))
      .limit(1);
    if (m) return { customer: m.customer, matchedOn: "adres" as const };
  }
  return null;
}

/** Uitlezen zonder iets op te slaan: gegevens, voorgestelde koppelingen en eventuele eerdere import. */
export async function previewGreenteamQuote(db: DbOrTx, dataBase64: string) {
  const parsed = await readPdf(dataBase64);
  const [already] = await db
    .select({ id: externalQuotes.id, customerId: externalQuotes.customerId })
    .from(externalQuotes)
    .where(and(eq(externalQuotes.source, SOURCE), eq(externalQuotes.externalNumber, parsed.externalNumber)));
  const match = await findCustomer(db, parsed.customer);
  const gt = await greenteam(db);
  const advisor = await findAdvisor(db, gt.organizationId, parsed.advisor);
  const [group] = parsed.productGroupKey ? await db.select().from(productGroups).where(eq(productGroups.key, parsed.productGroupKey)) : [];
  return {
    parsed,
    alreadyImported: already ?? null,
    existingCustomer: match
      ? { id: match.customer.id, name: [match.customer.firstName, match.customer.lastName].filter(Boolean).join(" "), displayNumber: formatCustomerNumber(match.customer.number), matchedOn: match.matchedOn }
      : null,
    advisor: advisor ? { id: advisor.id, name: advisor.name, isNew: false } : parsed.advisor.name && gt.organizationId ? { id: null, name: parsed.advisor.name, isNew: true } : null,
    productGroupId: group?.id ?? null,
    salesChannelId: gt.channelId,
  };
}

export interface ImportCustomerInput {
  firstName: string | null;
  lastName: string;
  email: string | null;
  phone: string | null;
  street: string;
  houseNumber: string;
  houseNumberAddition: string | null;
  postalCode: string;
  city: string;
}

/**
 * Leest de offerte opnieuw (de server vertrouwt alleen de PDF), maakt of koppelt de klant,
 * bewaart de PDF en de uitgelezen gegevens op de klantkaart. Eén transactie: alles of niets.
 */
export async function importGreenteamQuote(
  db: Db,
  actor: ActorContext,
  input: { filename: string; dataBase64: string; existingCustomerId: string | null; customer: ImportCustomerInput; productGroupId: string | null },
) {
  const parsed = await readPdf(input.dataBase64);
  return db.transaction(async (tx) => {
    const [already] = await tx
      .select({ customerId: externalQuotes.customerId })
      .from(externalQuotes)
      .where(and(eq(externalQuotes.source, SOURCE), eq(externalQuotes.externalNumber, parsed.externalNumber)));
    if (already) throw conflict("already_imported", `Offerte ${parsed.externalNumber} is al ingelezen`);

    const gt = await greenteam(tx);
    const c = input.customer;
    const property = { street: c.street, houseNumber: c.houseNumber, houseNumberAddition: c.houseNumberAddition, postalCode: c.postalCode, city: c.city };
    let customerId: string;
    let createdCustomer = false;
    if (input.existingCustomerId) {
      const [existing] = await tx.select().from(customers).where(eq(customers.id, input.existingCustomerId));
      if (!existing) throw notFound("Klant");
      customerId = existing.id;
      // Nieuw adres (andere woning) toevoegen; bestaande klantgegevens worden niet overschreven.
      const pc = normalizePostalCode(c.postalCode);
      const [hasAddress] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.customerId, customerId), eq(properties.postalCode, pc), eq(properties.houseNumber, c.houseNumber.trim())));
      if (!hasAddress) await addProperty(tx as unknown as Db, actor, customerId, property);
    } else {
      const created = await createCustomer(tx as unknown as Db, actor, {
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        salesChannelId: gt.channelId,
        notes: `Aangemaakt uit Greenteam-offerte ${parsed.externalNumber}.`,
        property,
      });
      customerId = created.id;
      createdCustomer = true;
    }

    let advisorId = (await findAdvisor(tx, gt.organizationId, parsed.advisor))?.id ?? null;
    let createdAdvisor = false;
    if (!advisorId && gt.organizationId && parsed.advisor.name) {
      const [a] = await tx
        .insert(advisors)
        .values({ organizationId: gt.organizationId, name: parsed.advisor.name, email: parsed.advisor.email, phone: parsed.advisor.phone })
        .returning();
      advisorId = a!.id;
      createdAdvisor = true;
      await recordAudit(tx, actor, { action: "advisor.created", entityType: "organization", entityId: gt.organizationId, after: a, metadata: { via: "greenteam_import" } });
    }

    if (input.productGroupId) {
      const [g] = await tx.select({ id: productGroups.id }).from(productGroups).where(eq(productGroups.id, input.productGroupId));
      if (!g) throw badRequest("unknown_product_group", "Productgroep bestaat niet");
    }

    const id = randomUUID();
    const file = await saveFile(tx, {
      ownerType: "external_quote",
      ownerId: id,
      filename: input.filename || `Offerte ${parsed.externalNumber}.pdf`,
      dataBase64: input.dataBase64,
      createdBy: actor.userId,
    });
    const [row] = await tx
      .insert(externalQuotes)
      .values({
        id,
        source: SOURCE,
        externalNumber: parsed.externalNumber,
        customerId,
        productGroupId: input.productGroupId,
        advisorId,
        quoteDate: parsed.quoteDate,
        validUntil: parsed.validUntil,
        signedDate: parsed.signedDate,
        installerName: parsed.installer.name,
        depositMethod: parsed.depositMethod,
        lines: parsed.lines,
        subtotalCents: parsed.subtotalCents,
        vatCents: parsed.vatCents,
        totalCents: parsed.totalCents,
        raw: parsed,
        fileId: file.id,
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, actor, {
      action: "external_quote.imported",
      entityType: "customer",
      entityId: customerId,
      metadata: { source: SOURCE, externalNumber: parsed.externalNumber, externalQuoteId: id, createdCustomer, createdAdvisor },
    });
    return { externalQuote: row!, customerId, createdCustomer, createdAdvisor };
  });
}

export async function listExternalQuotes(db: DbOrTx, customerId: string) {
  return db
    .select({
      id: externalQuotes.id,
      source: externalQuotes.source,
      externalNumber: externalQuotes.externalNumber,
      quoteDate: externalQuotes.quoteDate,
      validUntil: externalQuotes.validUntil,
      signedDate: externalQuotes.signedDate,
      installerName: externalQuotes.installerName,
      depositMethod: externalQuotes.depositMethod,
      lines: externalQuotes.lines,
      subtotalCents: externalQuotes.subtotalCents,
      vatCents: externalQuotes.vatCents,
      totalCents: externalQuotes.totalCents,
      productGroupName: productGroups.name,
      advisorName: advisors.name,
      filename: files.filename,
      hasFile: sql<boolean>`${files.data} is not null`,
      createdAt: externalQuotes.createdAt,
      createdByName: users.name,
    })
    .from(externalQuotes)
    .innerJoin(files, eq(files.id, externalQuotes.fileId))
    .leftJoin(productGroups, eq(productGroups.id, externalQuotes.productGroupId))
    .leftJoin(advisors, eq(advisors.id, externalQuotes.advisorId))
    .leftJoin(users, eq(users.id, externalQuotes.createdBy))
    .where(eq(externalQuotes.customerId, customerId))
    .orderBy(desc(externalQuotes.quoteDate), asc(externalQuotes.externalNumber));
}

export async function externalQuoteFile(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ file: files })
    .from(externalQuotes)
    .innerJoin(files, eq(files.id, externalQuotes.fileId))
    .where(eq(externalQuotes.id, id));
  if (!row?.file.data) throw notFound("Bestand");
  return row.file;
}
