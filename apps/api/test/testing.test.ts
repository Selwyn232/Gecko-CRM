import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { organizations } from "../src/modules/organizations/schema.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
});
afterAll(async () => ctx.close());

describe("testmodus en testscenario", () => {
  it("scenario alleen in testmodus; daarna schouw vandaag plannen en direct rapporteren", async () => {
    const groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "zonnepanelen")))[0]!.id;
    const channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
    const body = { productGroupId: groupId, email: "tester@example.nl", postalCode: "3511 AB" };
    expect((await call("POST", "/testing/scenario", body)).json().error.code).toBe("test_mode_off");

    await call("PUT", "/settings/test.mode", { value: true });
    expect((await call("POST", "/testing/scenario", body)).json().error.code).toBe("no_priced_package");
    const pkg = (await call("POST", "/products", { code: "ZP-TEST", name: "Zonnepanelen test", productGroupId: groupId, type: "package", vatCode: "nul" })).json();
    await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: channelId, priceCents: 500_000, validFrom: todayIso() });

    const res = await call("POST", "/testing/scenario", body);
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json();
    expect((await call("GET", `/projects/${s.projectId}`)).json().status.key).toBe("schouw_inplannen");
    // Standaard via "Greenteam (test)": testadviseur, fee en akkoordmails naar het testadres
    expect(s).toMatchObject({ salesChannelName: "Greenteam (test)", feeBasisPoints: 1000 });
    const quote = (await call("GET", `/quotes/${s.quoteId}`)).json();
    expect(quote.advisor.name).toBe("Testadviseur (test)");
    const orgs = (await ctx.db.select().from(organizations)).filter((o) => o.name.endsWith("(test)"));
    expect(orgs.map((o) => o.email)).toEqual(["tester@example.nl", "tester@example.nl"]);
    // Echte Greenteam ongewijzigd
    const [realGt] = await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "greenteam"));
    expect(realGt!.feeBasisPoints).toBeNull();

    // In testmodus: vandaag plannen (zonder voorlooptijd) en direct rapport indienen
    const slots = (await call("GET", `/planning/slots?projectId=${s.projectId}&type=survey`)).json().slots;
    expect(slots[0]).toMatchObject({ date: todayIso(), partnerId: s.partnerId });
    const appt = (await call("POST", `/projects/${s.projectId}/appointments`, { type: "survey", date: slots[3].date, technicianId: slots[3].technicianId, startMinute: slots[3].startMinute })).json();
    await processOutbox(ctx.db, ctx.app.billing);
    // Rapport als de testinstallateur (via inloggen-als) — ook als de afspraak pas later is
    const imp = await ctx.app.inject({ method: "POST", url: `/api/users/${s.partnerUserId}/impersonate`, headers: h });
    const cookie = imp.cookies.find((c) => c.name === "gecko_session")!.value;
    const rep = await call("POST", `/partner/appointments/${appt.id}/report`, { positive: true, data: { remarks: "test" } }, { cookie: `gecko_session=${cookie}` });
    expect(rep.statusCode, rep.body).toBe(200);

    // Tweede scenario hergebruikt dezelfde testinstallateur
    const s2 = (await call("POST", "/testing/scenario", body)).json();
    expect(s2.partnerId).toBe(s.partnerId);
    // Expliciet kanaal kiezen kan ook
    const s3 = (await call("POST", "/testing/scenario", { ...body, salesChannelId: channelId })).json();
    expect(s3.salesChannelName).toBe("Web");
    await call("PUT", "/settings/test.mode", { value: false });
  });
});
