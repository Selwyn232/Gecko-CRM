import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDutchDate, parseEuroCents, splitAddress, splitName } from "../src/modules/imports/greenteam.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });

/** Minimale PDF met tekst op vaste posities (Helvetica, WinAnsi), zoals het artikelblad van Greenteam. */
function makePdf(texts: [number, number, string][]) {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = texts.map(([x, y, s]) => `BT /F1 9 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 596 843] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

/** Nepofferte in de opmaak van Greenteam (geen echte persoonsgegevens). */
function greenteamPdf(o: { number: string; email: string; lines: [string, string][]; signed?: boolean }) {
  const t: [number, number, string][] = [
    [50, 704, `Offerte #${o.number}`],
    [50, 673, "Datum:"], [50, 658, "16 november 2026"], [219, 673, "Vervaldatum:"], [219, 658, "18 november 2026"],
    [50, 622, "Gegevens aanvrager"], [50, 607, "J. P. de Testmans"], [50, 595, "Trêd 75A 75A"], [50, 583, "8603 DZ Sneek"], [50, 572, o.email], [50, 561, "06 12345678"],
    [219, 622, "Gegevens uitvoerder"], [219, 607, "Installatiebedrijf B.V."], [219, 595, "Weg 1"], [219, 583, "1234AB Ergens"], [219, 572, "info@installateur.example"], [219, 561, "023-1234567"],
    [388, 622, "Gegevens adviseur"], [388, 607, "Greenteam - Ada Adviseur"], [388, 595, "Weg 2"], [388, 583, "1234AB Ergens"], [388, 572, "ada@greenteam.example"], [388, 561, "+31 71 000 0000"],
    [50, 535, "Aanbetalingsmethode:"], [148, 535, "Via Warmtefonds"],
    [50, 508, "OMSCHRIJVING"], [320, 508, "AANTAL"],
  ];
  let y = 486;
  for (const [desc, qty] of o.lines) {
    const parts = desc.split("\n");
    if (parts.length === 1) t.push([50, y, desc], [347, y, qty]);
    else t.push([50, y + 6, parts[0]!], [50, y - 7, parts[1]!], [347, y, qty]);
    y -= 23;
  }
  t.push([407, 349, "Subtotaal"], [497, 349, "€ 10.000,00"], [407, 329, "BTW 21%"], [502, 329, "€ 2.100,00"], [407, 310, "Totaal"], [497, 310, "€ 12.100,00"]);
  t.push([50, 134, "Akkoord aanvrager."], [111, 71, "Voor akkoord: Aanvrager"], [369, 71, "Voor akkoord: Adviseur"]);
  t.push([50, 40, "Datum:"], [95, 40, o.signed ? "17 november 2026" : "{{datum_aanvrager}}"], [304, 40, "Datum:"], [349, 40, "16 november 2026"]);
  return makePdf(t);
}

const batteryLines: [string, string][] = [
  ["KSTAR E10KT-D22 | 10 kW | 3 fasen", "1"],
  ["KSTAR BlueSpark Battery | 5,12 kWh", "2"],
  ["Service financiering via Warmtefonds / SVn (indien van\ntoepassing)", "1"],
];

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
});
afterAll(() => ctx.close());

describe("Greenteam-offerte uitlezen (hulpfuncties)", () => {
  it("adres, naam, bedragen en datums", () => {
    expect(splitAddress("Trêd 75 75")).toEqual({ street: "Trêd", houseNumber: "75", houseNumberAddition: null });
    expect(splitAddress("Van Goghlaan 12-B")).toEqual({ street: "Van Goghlaan", houseNumber: "12", houseNumberAddition: "B" });
    expect(splitAddress("Dorpsstraat 3A")).toEqual({ street: "Dorpsstraat", houseNumber: "3", houseNumberAddition: "A" });
    expect(splitName("I.M.M. Rozeboom-Priem")).toEqual({ firstName: "I.M.M.", lastName: "Rozeboom-Priem" });
    expect(splitName("Jan de Vries")).toEqual({ firstName: "Jan", lastName: "de Vries" });
    expect(splitName("J. P. van der Berg")).toEqual({ firstName: "J. P.", lastName: "van der Berg" });
    expect(splitName("Jan Pieter Jansen")).toEqual({ firstName: "Jan Pieter", lastName: "Jansen" });
    expect(parseEuroCents("€ 10.826,40")).toBe(1082640);
    expect(parseEuroCents("€ -12,05")).toBe(-1205);
    expect(parseDutchDate("16 november 2026")).toBe("2026-11-16");
    expect(parseDutchDate("{{datum_aanvrager}}")).toBeNull();
  });
});

describe("Greenteam-offerte inlezen", () => {
  let customerId: string;

  it("voorbeeld: leest alle velden en stelt koppelingen voor, zonder iets op te slaan", async () => {
    const r = await call("POST", "/imports/greenteam/preview", { filename: "offerte.pdf", dataBase64: greenteamPdf({ number: "900001", email: "Test@Example.nl", lines: batteryLines }) });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.parsed).toMatchObject({
      externalNumber: "900001",
      quoteDate: "2026-11-16",
      validUntil: "2026-11-18",
      customer: { firstName: "J. P.", lastName: "de Testmans", street: "Trêd", houseNumber: "75", houseNumberAddition: "A", postalCode: "8603DZ", city: "Sneek", email: "test@example.nl", phone: "0612345678" },
      installer: { name: "Installatiebedrijf B.V." },
      advisor: { organization: "Greenteam", name: "Ada Adviseur", email: "ada@greenteam.example" },
      depositMethod: "Via Warmtefonds",
      subtotalCents: 1000000,
      vatCents: 210000,
      totalCents: 1210000,
      signedDate: null,
      productGroupKey: "thuisbatterij",
      warnings: [],
    });
    expect(p.parsed.lines).toEqual([
      { description: "KSTAR E10KT-D22 | 10 kW | 3 fasen", quantity: 1 },
      { description: "KSTAR BlueSpark Battery | 5,12 kWh", quantity: 2 },
      { description: "Service financiering via Warmtefonds / SVn (indien van toepassing)", quantity: 1 },
    ]);
    expect(p.existingCustomer).toBeNull();
    expect(p.alreadyImported).toBeNull();
    expect(p.advisor).toMatchObject({ name: "Ada Adviseur", isNew: true });
    expect(p.productGroupId).toBeTruthy();
    expect(p.salesChannelId).toBeTruthy();
    expect((await call("GET", "/customers?limit=10")).json().total).toBe(0);
  });

  it("inlezen maakt klant (kanaal Greenteam), adres, adviseur en bewaart de PDF op de klantkaart", async () => {
    const dataBase64 = greenteamPdf({ number: "900001", email: "test@example.nl", lines: batteryLines, signed: true });
    const p = (await call("POST", "/imports/greenteam/preview", { filename: "offerte.pdf", dataBase64 })).json();
    const c = p.parsed.customer;
    const r = await call("POST", "/imports/greenteam", {
      filename: "Offerte_900001.pdf",
      dataBase64,
      existingCustomerId: null,
      productGroupId: p.productGroupId,
      customer: { firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, street: c.street, houseNumber: c.houseNumber, houseNumberAddition: c.houseNumberAddition, postalCode: c.postalCode, city: c.city },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ createdCustomer: true, createdAdvisor: true });
    customerId = r.json().customerId;

    const cust = (await call("GET", `/customers/${customerId}`)).json();
    expect(cust).toMatchObject({ firstName: "J. P.", lastName: "de Testmans", email: "test@example.nl", phone: "+31612345678", salesChannelId: p.salesChannelId });
    expect(cust.properties[0]).toMatchObject({ street: "Trêd", houseNumber: "75", houseNumberAddition: "A", postalCode: "8603DZ", city: "Sneek" });

    const list = (await call("GET", `/customers/${customerId}/external-quotes`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ externalNumber: "900001", totalCents: 1210000, signedDate: "2026-11-17", advisorName: "Ada Adviseur", productGroupName: "Thuisbatterij", hasFile: true, filename: "Offerte_900001.pdf" });

    const pdf = await call("GET", `/external-quotes/${list[0].id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const timeline = (await call("GET", `/customers/${customerId}/timeline`)).json();
    expect(timeline.some((e: { title: string }) => e.title === "Greenteam-offerte 900001 ingelezen")).toBe(true);
  });

  it("dezelfde offerte twee keer inlezen kan niet", async () => {
    const dataBase64 = greenteamPdf({ number: "900001", email: "test@example.nl", lines: batteryLines });
    expect((await call("POST", "/imports/greenteam/preview", { filename: "x.pdf", dataBase64 })).json().alreadyImported.customerId).toBe(customerId);
    const r = await call("POST", "/imports/greenteam", {
      filename: "x.pdf",
      dataBase64,
      customer: { lastName: "X", street: "S", houseNumber: "1", postalCode: "1234AB", city: "Y" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("tweede offerte van dezelfde klant wordt herkend en gekoppeld (geen dubbele klant, adviseur hergebruikt)", async () => {
    const dataBase64 = greenteamPdf({ number: "900002", email: "TEST@example.nl", lines: [["WeHeat Flint P40 | Hybride Warmtepomp", "1"], ["Buffervat 25 liter", "1"]] });
    const p = (await call("POST", "/imports/greenteam/preview", { filename: "wp.pdf", dataBase64 })).json();
    expect(p.existingCustomer).toMatchObject({ id: customerId, matchedOn: "e-mailadres" });
    expect(p.advisor).toMatchObject({ isNew: false });
    expect(p.parsed.productGroupKey).toBe("warmtepomp");
    const c = p.parsed.customer;
    const r = await call("POST", "/imports/greenteam", { filename: "wp.pdf", dataBase64, existingCustomerId: customerId, productGroupId: p.productGroupId, customer: { ...c, fullName: undefined } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ createdCustomer: false, createdAdvisor: false, customerId });
    expect((await call("GET", "/customers?limit=10")).json().total).toBe(1);
    expect((await call("GET", `/customers/${customerId}`)).json().properties).toHaveLength(1);
    expect((await call("GET", `/customers/${customerId}/external-quotes`)).json()).toHaveLength(2);
  });

  it("weigert andere bestanden met een duidelijke melding", async () => {
    const notGt = await call("POST", "/imports/greenteam/preview", { filename: "a.pdf", dataBase64: makePdf([[50, 700, "Factuur 123"]]) });
    expect(notGt.statusCode).toBe(400);
    expect(notGt.json().error.code).toBe("not_greenteam_quote");
    const notPdf = await call("POST", "/imports/greenteam/preview", { filename: "a.pdf", dataBase64: Buffer.from("hallo wereld").toString("base64") });
    expect(notPdf.json().error.code).toBe("not_pdf");
  });

  it("anonimiseren wist de PDF en de uitgelezen persoonsgegevens", async () => {
    const r = await call("POST", `/customers/${customerId}/anonymize`, { reason: "verzoek klant", confirm: "ANONIMISEREN" });
    expect(r.statusCode, r.body).toBe(200);
    const list = (await call("GET", `/customers/${customerId}/external-quotes`)).json();
    expect(list.every((q: { hasFile: boolean }) => !q.hasFile)).toBe(true);
    expect((await call("GET", `/external-quotes/${list[0].id}/pdf`)).statusCode).toBe(404);
  });

  it("zonder klantrechten geen toegang", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/api/imports/greenteam/preview", payload: { filename: "a.pdf", dataBase64: "JVBERi0xLjQ=" } });
    expect(r.statusCode).toBe(401);
  });
});
