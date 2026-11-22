import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

let groupId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
  groupId = (await ctx.db.select().from(productGroups).where(eq(productGroups.key, "warmtepomp")))[0]!.id;
  const channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  const pkg = (await call("POST", "/products", { code: "WP", name: "Warmtepomp", productGroupId: groupId, type: "package", vatCode: "hoog" })).json();
  await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: channelId, priceCents: 900_000, validFrom: todayIso() });
  await call("PUT", "/settings/test.mode", { value: true });
});
afterAll(async () => ctx.close());

describe("checklists", () => {
  it("startlijst per productgroep; instellen met verplichte punten en minimum foto's", async () => {
    const all = (await call("GET", "/checklists")).json();
    const wp = all.find((g: { productGroup: { id: string } }) => g.productGroup.id === groupId);
    expect(wp.survey.items.map((i: { label: string }) => i.label)).toContain("Meterkast beoordeeld");
    expect((await call("PUT", `/checklists/${groupId}/survey`, { items: [{ label: "A", required: false }, { label: "a", required: true }], minPhotos: 0 })).json().error.code).toBe("duplicate_label");
    const saved = (await call("PUT", `/checklists/${groupId}/survey`, { items: [{ label: "Buitenunit-plek bepaald", required: true }, { label: "Geluid besproken", required: false }], minPhotos: 1 })).json();
    expect(saved).toMatchObject({ minPhotos: 1, items: [{ label: "Buitenunit-plek bepaald", required: true }, { label: "Geluid besproken", required: false }] });
  });

  it("partnerportaal krijgt de lijst; positief rapport alleen met verplichte punten en genoeg foto's; afkeuren telt voor first-time-right", async () => {
    const s = (await call("POST", "/testing/scenario", { productGroupId: groupId, email: "t@example.nl", postalCode: "3511 AB", salesChannelId: (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id })).json();
    const slots = (await call("GET", `/planning/slots?projectId=${s.projectId}&type=survey`)).json().slots;
    const appt = (await call("POST", `/projects/${s.projectId}/appointments`, { type: "survey", date: slots[0].date, technicianId: slots[0].technicianId, startMinute: slots[0].startMinute })).json();
    await processOutbox(ctx.db, ctx.app.billing);
    const imp = await call("POST", `/users/${s.partnerUserId}/impersonate`);
    const ph = { cookie: `gecko_session=${imp.cookies.find((c) => c.name === "gecko_session")!.value}` };

    const detail = (await call("GET", `/partner/appointments/${appt.id}`, undefined, ph)).json();
    expect(detail.checklist.minPhotos).toBe(1);
    expect(detail.checklist.items[0]).toMatchObject({ label: "Buitenunit-plek bepaald", required: true });

    const report = (body: object) => call("POST", `/partner/appointments/${appt.id}/report`, body, ph);
    expect((await report({ positive: true, data: { checklist: {} } })).json().error.code).toBe("checklist_incomplete");
    expect((await report({ positive: true, data: { checklist: { "Buitenunit-plek bepaald": true } } })).json().error.code).toBe("photos_required");
    // Negatief rapport (niet haalbaar) mag zonder
    await call("POST", `/partner/appointments/${appt.id}/files`, { filename: "plek.jpg", dataBase64: JPEG }, ph);
    const ok = await report({ positive: true, data: { checklist: { "Buitenunit-plek bepaald": true } } });
    expect(ok.statusCode, ok.body).toBe(200);

    // Afkeuren en opnieuw indienen: telt als afgekeurd rapport bij de installateur
    await call("POST", `/reports/${ok.json().id}/review`, { approve: false, note: "foto onscherp" });
    const again = await report({ positive: true, data: { checklist: { "Buitenunit-plek bepaald": true } } });
    expect(again.statusCode, again.body).toBe(200);
    const partners = (await call("GET", "/reports/overview")).json().partners;
    expect(partners.find((p: { partnerId: string }) => p.partnerId === s.partnerId).rejectedReports).toBe(1);
  });
});
