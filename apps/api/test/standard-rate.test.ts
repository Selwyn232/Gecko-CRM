import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups } from "../src/modules/catalog/schema.js";
import { partnerAmount } from "../src/modules/selfbilling/service.js";
import { adminSession, createTestContext, geckoOrgId, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => ctx.app.inject({ method, url: `/api${url}`, headers: h, payload: payload as object });
let pkg: string;
let labor: string;
let noord: string;
let zuid: string;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "zonnepanelen")))[0]!.id;
  const supplier = (await call("POST", "/organizations", { name: "OSW", type: "supplier" })).json().id;
  noord = (await call("POST", "/organizations", { name: "Noord", type: "installation_partner" })).json().id;
  zuid = (await call("POST", "/organizations", { name: "Zuid", type: "installation_partner" })).json().id;
  const panel = (await call("POST", "/products", { code: "PANEEL", name: "Paneel", productGroupId: groupId, type: "component", vatCode: "hoog", defaultSupplierOrganizationId: supplier })).json().id;
  labor = (await call("POST", "/products", { code: "INSTALLATIE", name: "Installatie", productGroupId: groupId, type: "labor", vatCode: "hoog" })).json().id;
  pkg = (await call("POST", "/products", { code: "PAKKET", name: "Pakket", productGroupId: groupId, type: "package", vatCode: "hoog" })).json().id;
  await call("PUT", `/products/${pkg}/bom`, { items: [{ componentProductId: panel, quantity: 9 }, { componentProductId: labor, quantity: 1 }] });
  await call("POST", `/products/${panel}/purchase-prices`, { scopeId: supplier, priceCents: 50_000, validFrom: todayIso() });
  // Standaardtarief (op Gecko) en een eigen tarief voor Noord
  const std = await call("POST", `/products/${labor}/partner-rates`, { scopeId: await geckoOrgId(ctx.db), priceCents: 120_000, validFrom: todayIso() });
  expect(std.statusCode, std.body).toBe(201);
  await call("POST", `/products/${labor}/partner-rates`, { scopeId: noord, priceCents: 100_000, validFrom: todayIso() });
});
afterAll(async () => ctx.close());

describe("standaard partnertarief", () => {
  it("kostprijs zonder installateur gebruikt het standaardtarief; met installateur diens eigen tarief", async () => {
    const none = (await call("GET", `/products/${pkg}/cost`)).json();
    expect(none).toMatchObject({ complete: true, totalCents: 450_000 + 120_000 });
    expect(none.lines.find((l: { code: string }) => l.code === "INSTALLATIE").source).toBe("standard");

    const withNoord = (await call("GET", `/products/${pkg}/cost?partnerOrganizationId=${noord}`)).json();
    expect(withNoord.totalCents).toBe(450_000 + 100_000);
    expect(withNoord.lines.find((l: { code: string }) => l.code === "INSTALLATIE").source).toBe("partner");

    // Zuid heeft geen eigen tarief: schatting met standaardtarief
    const withZuid = (await call("GET", `/products/${pkg}/cost?partnerOrganizationId=${zuid}`)).json();
    expect(withZuid).toMatchObject({ complete: true, totalCents: 570_000 });
  });

  it("uitbetalen (selfbilling) gebeurt nooit tegen het standaardtarief", async () => {
    expect(await partnerAmount(ctx.db, pkg, "1", noord, todayIso())).toEqual({ cents: 100_000, missing: [] });
    const zuidPay = await partnerAmount(ctx.db, pkg, "1", zuid, todayIso());
    expect(zuidPay.missing).toEqual(["INSTALLATIE"]);
  });
});
