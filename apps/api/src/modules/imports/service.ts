import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { todayIso } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { recordAudit } from "../audit/service.js";
import { users } from "../auth/schema.js";
import { effectivePrice } from "../catalog/prices.js";
import { productGroups, products, salesChannels } from "../catalog/schema.js";
import { createProduct } from "../catalog/service.js";
import { customers, properties } from "../customers/schema.js";
import { addProperty, createCustomer, formatCustomerNumber, normalizePostalCode } from "../customers/service.js";
import { files } from "../files/schema.js";
import { MAX_FILE_BYTES, saveFile } from "../files/storage.js";
import { advisors } from "../organizations/schema.js";
import { formatProjectNumber } from "../projects/service.js";
import { projects } from "../projects/schema.js";
import { calculateTotals, createPartnerSignedQuoteInTx, formatQuoteNumber } from "../quotes/service.js";
import { quotes } from "../quotes/schema.js";
import { isGreenteamQuote, parseGreenteamQuote, type ParsedGreenteamQuote } from "./greenteam.js";
import { allocatePrices, descriptionKey, guessLineType, isConditionLine, type LineType } from "./lines.js";
import { extractPdfText } from "./pdf.js";
import { externalQuotes, productAliases } from "./schema.js";

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
  return { parsed: parseGreenteamQuote(pages), sha256: createHash("sha256").update(buf).digest("hex") };
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

// ---------------------------------------------------------------- Regels → producten

export type LineChoice =
  | { action: "product"; productId: string }
  | { action: "new"; code: string; name: string; type: LineType }
  | { action: "skip" };

export interface LineSuggestion {
  description: string;
  quantity: number;
  choice: LineChoice;
  /** Waarom deze keuze: eerder gekoppeld, gelijke naam, nieuw product, of voorwaarde. */
  reason: "alias" | "name" | "new" | "condition";
}

/** Producten van de productgroep, met de verkoopprijs voor Greenteam (voor de prijsverdeling). */
export async function groupProducts(db: DbOrTx, productGroupId: string) {
  const gt = await greenteam(db);
  const rows = await db.select().from(products).where(and(eq(products.productGroupId, productGroupId), eq(products.isActive, true))).orderBy(asc(products.code));
  const today = todayIso();
  return Promise.all(
    rows.map(async (p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      type: p.type,
      salesPriceCents: gt.channelId ? ((await effectivePrice(db, "sales", p.id, gt.channelId, today))?.priceCents ?? null) : null,
    })),
  );
}

/** Voorstel per regel: eerder gekoppeld product, anders product met dezelfde naam, anders nieuw; voorwaarden overslaan. */
export async function suggestLines(db: DbOrTx, productGroupId: string, lines: { description: string; quantity: number }[]) {
  const keys = lines.map((l) => descriptionKey(l.description));
  const aliases = keys.length
    ? await db
        .select({ key: productAliases.descriptionKey, productId: productAliases.productId })
        .from(productAliases)
        .innerJoin(products, eq(products.id, productAliases.productId))
        .where(and(eq(productAliases.source, SOURCE), eq(productAliases.productGroupId, productGroupId), inArray(productAliases.descriptionKey, keys), eq(products.isActive, true)))
    : [];
  const prods = await groupProducts(db, productGroupId);
  const suggestions: LineSuggestion[] = lines.map((l, i) => {
    const alias = aliases.find((a) => a.key === keys[i]);
    if (alias) return { ...l, choice: { action: "product", productId: alias.productId }, reason: "alias" };
    const byName = prods.find((p) => descriptionKey(p.name) === keys[i]);
    if (byName) return { ...l, choice: { action: "product", productId: byName.id }, reason: "name" };
    if (isConditionLine(l.description)) return { ...l, choice: { action: "skip" }, reason: "condition" };
    return { ...l, choice: { action: "new", code: "", name: l.description, type: guessLineType(l.description) }, reason: "new" };
  });
  return { lines: suggestions, products: prods };
}

// ---------------------------------------------------------------- Voorbeeld

/** Uitlezen zonder iets op te slaan: gegevens, voorgestelde koppelingen en eventuele eerdere import. */
export async function previewGreenteamQuote(db: DbOrTx, dataBase64: string) {
  const { parsed } = await readPdf(dataBase64);
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
    lineSuggestions: group ? await suggestLines(db, group.id, parsed.lines) : null,
  };
}

// ---------------------------------------------------------------- Inlezen

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
 * Een getekende Greenteam-offerte inlezen als order aan Gecko, in één transactie (alles of niets):
 * klant (nieuw of bestaand) met woning, adviseur, nieuwe producten en koppelingen, geaccepteerde
 * Gecko-offerte met de afgesproken prijs, project (klantreis start) en de PDF als origineel op de klantkaart.
 * De server leest de PDF zelf opnieuw; van de gebruiker komen alleen de gecontroleerde klantgegevens en de productkeuzes.
 */
export async function importGreenteamQuote(
  db: Db,
  actor: ActorContext,
  input: {
    filename: string;
    dataBase64: string;
    existingCustomerId: string | null;
    customer: ImportCustomerInput;
    productGroupId: string;
    lines: LineChoice[];
  },
) {
  const { parsed, sha256 } = await readPdf(input.dataBase64);
  if (input.lines.length !== parsed.lines.length) throw badRequest("lines_mismatch", "Kies voor elke regel van de offerte een product of 'overslaan'");
  if (parsed.subtotalCents == null) throw badRequest("no_amount", "Het bedrag (subtotaal) op de offerte is niet gevonden");
  return db.transaction(async (tx) => {
    const [already] = await tx
      .select({ customerId: externalQuotes.customerId })
      .from(externalQuotes)
      .where(and(eq(externalQuotes.source, SOURCE), eq(externalQuotes.externalNumber, parsed.externalNumber)));
    if (already) throw conflict("already_imported", `Offerte ${parsed.externalNumber} is al ingelezen`);

    const gt = await greenteam(tx);
    if (!gt.channelId) throw badRequest("no_greenteam_channel", "Verkoopkanaal 'greenteam' bestaat niet");
    const [group] = await tx.select().from(productGroups).where(eq(productGroups.id, input.productGroupId));
    if (!group) throw badRequest("unknown_product_group", "Productgroep bestaat niet");

    // Klant en woning
    const c = input.customer;
    const property = { street: c.street, houseNumber: c.houseNumber, houseNumberAddition: c.houseNumberAddition, postalCode: c.postalCode, city: c.city };
    let customerId: string;
    let propertyId: string;
    let createdCustomer = false;
    if (input.existingCustomerId) {
      const [existing] = await tx.select().from(customers).where(eq(customers.id, input.existingCustomerId));
      if (!existing) throw notFound("Klant");
      customerId = existing.id;
      const [same] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.customerId, customerId), eq(properties.postalCode, normalizePostalCode(c.postalCode)), eq(properties.houseNumber, c.houseNumber.trim())));
      propertyId = same?.id ?? (await addProperty(tx as unknown as Db, actor, customerId, property)).id;
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
      propertyId = created.properties[0]!.id;
      createdCustomer = true;
    }

    // Adviseur
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

    // Regels → producten (nieuwe producten aanmaken, koppeling onthouden)
    const createdProducts: string[] = [];
    const mapped: { productId: string; quantity: number; description: string }[] = [];
    const skipped: string[] = [];
    for (const [i, choice] of input.lines.entries()) {
      const line = parsed.lines[i]!;
      if (choice.action === "skip") {
        skipped.push(line.description);
        continue;
      }
      let productId: string;
      if (choice.action === "new") {
        const [dup] = await tx.select({ id: products.id }).from(products).where(eq(products.code, choice.code.trim().toUpperCase()));
        if (dup) throw conflict("product_code_taken", `Productcode ${choice.code} bestaat al; kies het bestaande product of een andere code`);
        const p = await createProduct(tx as unknown as Db, actor, { code: choice.code, name: choice.name.trim() || line.description, productGroupId: group.id, type: choice.type, vatCode: "hoog" });
        productId = p.id;
        createdProducts.push(p.code);
      } else {
        const [p] = await tx.select().from(products).where(eq(products.id, choice.productId));
        if (!p || p.productGroupId !== group.id) throw badRequest("wrong_product_group", "Gekozen product hoort niet bij de productgroep");
        productId = p.id;
      }
      await tx
        .insert(productAliases)
        .values({ source: SOURCE, productGroupId: group.id, descriptionKey: descriptionKey(line.description), description: line.description, productId, createdBy: actor.userId })
        .onConflictDoUpdate({ target: [productAliases.source, productAliases.productGroupId, productAliases.descriptionKey], set: { productId } });
      mapped.push({ productId, quantity: line.quantity, description: line.description });
    }
    if (!mapped.length) throw badRequest("no_lines", "Minstens één regel moet aan een product gekoppeld zijn");

    // Prijs: de afgesproken prijs van de offerte is leidend (zie allocatePrices).
    // Prijsdatum = inleesdatum: dan gelden de actuele kostprijzen en tarieven (ingangsdatums liggen nooit in het verleden).
    const priceDate = todayIso();
    const catalog = await Promise.all(mapped.map(async (m) => (await effectivePrice(tx, "sales", m.productId, gt.channelId!, priceDate))?.priceCents ?? null));
    const unitPrices = allocatePrices(mapped.map((m, i) => ({ quantity: m.quantity, catalogUnitCents: catalog[i]! })), parsed.subtotalCents!);
    const lines = mapped.map((m, i) => ({ ...m, unitPriceCents: unitPrices[i]! }));

    const notes = [
      `Getekend bij Greenteam (offerte #${parsed.externalNumber}${parsed.signedDate ? `, ondertekend ${parsed.signedDate}` : ""}); ingelezen uit de PDF. De prijs van de Greenteam-offerte is leidend; het restant staat op de eerste regel.`,
      skipped.length ? `Niet als regel overgenomen: ${skipped.join("; ")}.` : null,
    ].filter(Boolean);
    const id = randomUUID();
    const file = await saveFile(tx, { ownerType: "external_quote", ownerId: id, filename: input.filename || `Offerte ${parsed.externalNumber}.pdf`, dataBase64: input.dataBase64, createdBy: actor.userId });
    const { quote, projectId } = await createPartnerSignedQuoteInTx(tx, actor, {
      customerId,
      propertyId,
      productGroupId: group.id,
      salesChannelId: gt.channelId,
      advisorId,
      installationPartnerId: null,
      internalNote: notes.join("\n"),
      lines,
      priceDate,
      validUntil: parsed.validUntil,
      acceptedAt: parsed.signedDate ? new Date(`${parsed.signedDate}T12:00:00Z`) : new Date(),
      acceptedByName: parsed.customer.fullName || [c.firstName, c.lastName].filter(Boolean).join(" "),
      evidence: { source: SOURCE, externalNumber: parsed.externalNumber, externalQuoteId: id, fileId: file.id, pdfSha256: sha256, signedDate: parsed.signedDate, importedBy: actor.userId },
      paymentMethod: /warmtefonds/i.test(parsed.depositMethod ?? "") ? "warmtefonds" : "direct",
    });

    // Controle: komt het Gecko-totaal (incl. btw) overeen met de offerte?
    const totals = calculateTotals(quote.lines.map((l) => ({ quantity: l.quantity, unitPriceCents: l.unitPriceCents, vatRateBasisPoints: l.vatRateBasisPoints })));
    const warnings: string[] = [];
    if (parsed.totalCents != null && totals.totalCents !== parsed.totalCents) {
      warnings.push(`Totaal incl. btw wijkt af: Gecko € ${(totals.totalCents / 100).toFixed(2)} tegen offerte € ${(parsed.totalCents / 100).toFixed(2)} (andere btw-tarieven of afronding)`);
    }

    const [row] = await tx
      .insert(externalQuotes)
      .values({
        id,
        source: SOURCE,
        externalNumber: parsed.externalNumber,
        customerId,
        productGroupId: group.id,
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
        quoteId: quote.id,
        projectId,
        fileId: file.id,
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, actor, {
      action: "external_quote.imported",
      entityType: "customer",
      entityId: customerId,
      metadata: { source: SOURCE, externalNumber: parsed.externalNumber, externalQuoteId: id, quoteId: quote.id, projectId, createdCustomer, createdAdvisor, createdProducts, warnings },
    });
    return {
      externalQuote: row!,
      customerId,
      quoteId: quote.id,
      quoteNumber: quote.displayNumber,
      projectId,
      createdCustomer,
      createdAdvisor,
      createdProducts,
      warnings,
    };
  });
}

export async function listExternalQuotes(db: DbOrTx, customerId: string) {
  const rows = await db
    .select({
      id: externalQuotes.id,
      source: externalQuotes.source,
      externalNumber: externalQuotes.externalNumber,
      quoteDate: externalQuotes.quoteDate,
      validUntil: externalQuotes.validUntil,
      signedDate: externalQuotes.signedDate,
      depositMethod: externalQuotes.depositMethod,
      lines: externalQuotes.lines,
      subtotalCents: externalQuotes.subtotalCents,
      vatCents: externalQuotes.vatCents,
      totalCents: externalQuotes.totalCents,
      productGroupName: productGroups.name,
      advisorName: advisors.name,
      quoteId: externalQuotes.quoteId,
      quoteNumber: quotes.number,
      projectId: externalQuotes.projectId,
      projectNumber: projects.number,
      filename: files.filename,
      hasFile: sql<boolean>`${files.data} is not null`,
      createdAt: externalQuotes.createdAt,
      createdByName: users.name,
    })
    .from(externalQuotes)
    .innerJoin(files, eq(files.id, externalQuotes.fileId))
    .leftJoin(productGroups, eq(productGroups.id, externalQuotes.productGroupId))
    .leftJoin(advisors, eq(advisors.id, externalQuotes.advisorId))
    .leftJoin(quotes, eq(quotes.id, externalQuotes.quoteId))
    .leftJoin(projects, eq(projects.id, externalQuotes.projectId))
    .leftJoin(users, eq(users.id, externalQuotes.createdBy))
    .where(eq(externalQuotes.customerId, customerId))
    .orderBy(desc(externalQuotes.quoteDate), asc(externalQuotes.externalNumber));
  return rows.map((r) => ({
    ...r,
    quoteNumber: r.quoteNumber == null ? null : formatQuoteNumber(r.quoteNumber),
    projectNumber: r.projectNumber == null ? null : formatProjectNumber(r.projectNumber),
  }));
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
