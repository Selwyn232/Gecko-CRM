import { createHash } from "node:crypto";
import type { QuoteView } from "./service.js";

const fullName = (c: { firstName: string | null; lastName: string }) => [c.firstName, c.lastName].filter(Boolean).join(" ");
const address = (p: QuoteView["property"]) =>
  `${p.street} ${p.houseNumber}${p.houseNumberAddition ? `-${p.houseNumberAddition}` : ""}, ${p.postalCode} ${p.city}`;

/**
 * Vingerafdruk van alles wat de klant ziet en accepteert. Wordt bij definitief maken vastgelegd en bij
 * akkoord opnieuw berekend: zo is aantoonbaar dat de geaccepteerde offerte niet is gewijzigd.
 */
export function quoteContentHash(q: QuoteView) {
  const canonical = {
    number: q.displayNumber,
    customer: fullName(q.customer),
    address: address(q.property),
    productGroup: q.productGroup.name,
    priceDate: q.priceDate,
    validUntil: q.validUntil,
    customerNote: q.customerNote ?? "",
    lines: q.lines.map((l) => [l.productCode, l.description, l.quantity, l.unitPriceCents, l.vatRateBasisPoints]),
    totals: q.totals,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

