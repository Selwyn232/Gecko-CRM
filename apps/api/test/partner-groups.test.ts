import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { productGroups, salesChannels } from "../src/modules/catalog/schema.js";
import { MemoryTransport } from "../src/modules/email/transport.js";
import { quotes } from "../src/modules/quotes/schema.js";
import { adminSession, createTestContext, type TestContext } from "./helpers.js";

const mail = new MemoryTransport();
let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

let wp: string;
let bat: string;
let channelId: string;

beforeAll(async () => {
  ctx = await createTestContext({ emailTransport: mail });
  h = (await adminSession(ctx)).headers;
  const groups = await ctx.db.select().from(productGroups);
  wp = groups.find((g) => g.key === "warmtepomp")!.id;
  bat = groups.find((g) => g.key === "thuisbatterij")!.id;
  channelId = (await ctx.db.select().from(salesChannels).where(eq(salesChannels.key, "web")))[0]!.id;
  await call("PUT", "/settings/planning.survey_lead_days", { value: 0 });
});
afterAll(() => ctx.close());

const tokenFrom = (html: string) => /account-activeren\/([A-Za-z0-9_-]+)/.exec(html)![1]!;

describe("installatiepartner: account verplicht", () => {
  it("zonder productgroep of contactpersoon kan een installatiepartner niet worden aangemaakt", async () => {
    const noGroups = await call("POST", "/organizations", { name: "X", type: "installation_partner", account: { name: "A", email: "a@example.nl" } });
    expect(noGroups.json().error.code).toBe("partner_groups_required");
    const noAccount = await call("POST", "/organizations", { name: "X", type: "installation_partner", productGroupIds: [wp] });
    expect(noAccount.json().error.code).toBe("partner_account_required");
    // Andere organisaties hebben dit niet nodig
    expect((await call("POST", "/organizations", { name: "Leverancier", type: "supplier" })).statusCode).toBe(201);
  });

  it("aanmaken maakt een account met rol Installatiepartner en stuurt een uitnodiging; activeren met eigen wachtwoord", async () => {
    const r = await call("POST", "/organizations", {
      name: "Roke Group",
      type: "installation_partner",
      productGroupIds: [wp],
      account: { name: "Rob Roke", email: "Rob@Roke.example" },
    });
    expect(r.statusCode, r.body).toBe(201);
    const org = r.json();
    expect(org).toMatchObject({ productGroupIds: [wp], userCount: 1, email: "Rob@Roke.example" });
    expect(org.invite.emailStatus).toBe("sent");

    const sent = mail.sent.at(-1)!;
    expect(sent.to).toBe("rob@roke.example");
    expect(sent.subject).toMatch(/Uw account/);
    const token = tokenFrom(sent.html);
    expect(org.invite.url).toContain(token);

    const users = (await call("GET", "/users")).json() as { email: string; organizationId: string; roleIds: string[] }[];
    expect(users.find((u) => u.email === "rob@roke.example")).toMatchObject({ organizationId: org.id });

    // Activatiepagina
    const info = await ctx.app.inject({ method: "GET", url: `/api/public/invites/${token}` });
    expect(info.json()).toMatchObject({ name: "Rob Roke", email: "rob@roke.example", organizationName: "Roke Group" });
    const weak = await ctx.app.inject({ method: "POST", url: `/api/public/invites/${token}`, payload: { password: "kort" } });
    expect(weak.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: "POST", url: `/api/public/invites/${token}`, payload: { password: "een-sterk-wachtwoord-2026" } });
    expect(ok.statusCode, ok.body).toBe(200);
    // Link is eenmalig
    expect((await ctx.app.inject({ method: "POST", url: `/api/public/invites/${token}`, payload: { password: "nog-een-sterk-wachtwoord" } })).json().error.code).toBe("invite_invalid");
    // Inloggen met het eigen wachtwoord lukt (daarna 2FA instellen)
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "rob@roke.example", password: "een-sterk-wachtwoord-2026" } });
    expect(login.statusCode, login.body).toBe(200);
  });

  it("e-mailadres dat al in gebruik is wordt geweigerd, zonder halve partner", async () => {
    const before = (await call("GET", "/organizations?type=installation_partner")).json().length;
    const r = await call("POST", "/organizations", { name: "Dubbel", type: "installation_partner", productGroupIds: [wp], account: { name: "B", email: "rob@roke.example" } });
    expect(r.statusCode).toBe(409);
    expect((await call("GET", "/organizations?type=installation_partner")).json().length).toBe(before);
  });

  it("bestaande partner zonder account: account aanmaken en uitnodiging opnieuw sturen", async () => {
    // Zoals oude partners: direct in de database, zonder account
    const { organizations } = await import("../src/modules/organizations/schema.js");
    const [old] = await ctx.db.insert(organizations).values({ name: "Oude Partner", type: "installation_partner" }).returning();
    expect((await call("GET", `/organizations/${old!.id}`)).json()).toMatchObject({ userCount: 0, productGroupIds: [] });
    const r = await call("POST", `/organizations/${old!.id}/account`, { name: "Olaf", email: "olaf@oud.example" });
    expect(r.statusCode, r.body).toBe(201);
    const first = tokenFrom(mail.sent.at(-1)!.html);
    const again = await call("POST", `/users/${r.json().userId}/invite`);
    expect(again.statusCode).toBe(200);
    // De eerste link vervalt bij een nieuwe uitnodiging
    expect((await ctx.app.inject({ method: "GET", url: `/api/public/invites/${first}` })).json().error.code).toBe("invite_invalid");
    expect((await call("GET", `/organizations/${old!.id}`)).json()).toMatchObject({ userCount: 1, email: "olaf@oud.example" });
  });
});

describe("installatiepartner per productgroep", () => {
  let roke: string;
  let samen: string;
  let batProject: string;

  beforeAll(async () => {
    const orgs = (await call("GET", "/organizations?type=installation_partner")).json() as { id: string; name: string }[];
    roke = orgs.find((o) => o.name === "Roke Group")!.id;
    samen = (await call("POST", "/organizations", { name: "Samenstromen", type: "installation_partner", productGroupIds: [bat], account: { name: "Sam", email: "sam@samenstromen.example" } })).json().id;
    const region = (await call("POST", "/regions", { name: "Friesland", postalRanges: [[8000, 9999]] })).json().id;
    const today = todayIso();
    for (const p of [roke, samen]) {
      await call("PUT", `/planning/partner-regions/${p}`, { regionIds: [region] });
      await call("PUT", "/planning/availability", { partnerId: p, changes: [{ date: today, part: "morning", available: true }, { date: today, part: "afternoon", available: true }] });
    }
    const c = (await call("POST", "/customers", { lastName: "Batterij", property: { street: "Trêd", houseNumber: "75", postalCode: "8603DZ", city: "Sneek" } })).json();
    batProject = (await call("POST", "/projects", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: bat, salesChannelId: channelId })).json().id;
    // B86: plannen vereist een geaccepteerde offerte
    await ctx.db.insert(quotes).values({ customerId: c.id, propertyId: c.properties[0].id, productGroupId: bat, salesChannelId: channelId, projectId: batProject, status: "accepted" });
  });

  it("productgroepen zijn per partner in te stellen", async () => {
    const r = await call("PATCH", `/organizations/${roke}`, { productGroupIds: [wp] });
    expect(r.json().productGroupIds).toEqual([wp]);
    expect((await call("PATCH", `/organizations/${roke}`, { productGroupIds: [] })).json().error.code).toBe("partner_groups_required");
  });

  it("planvoorstel voor een batterij toont alleen de batterijpartner", async () => {
    const slots = (await call("GET", `/planning/slots?projectId=${batProject}&type=survey`)).json();
    const partners = [...new Set(slots.slots.map((s: { partnerId: string }) => s.partnerId))];
    expect(partners).toEqual([samen]);
  });

  it("de warmtepomppartner kan niet worden ingepland of gekozen voor een batterijproject", async () => {
    const plan = await call("POST", `/projects/${batProject}/appointments`, { type: "survey", date: todayIso(), partnerId: roke, part: "morning" });
    expect(plan.json().error?.code).toBe("partner_wrong_group");
    expect(plan.json().error.message).toMatch(/Roke Group installeert geen thuisbatterij/);
    const set = await call("PATCH", `/projects/${batProject}`, { installationPartnerId: roke });
    expect(set.json().error.code).toBe("partner_wrong_group");
    expect((await call("PATCH", `/projects/${batProject}`, { installationPartnerId: samen })).statusCode).toBe(200);
  });

  it("als geen partner de productgroep doet: duidelijke melding", async () => {
    await call("PATCH", `/organizations/${samen}`, { productGroupIds: [wp] });
    await call("PATCH", `/projects/${batProject}`, { installationPartnerId: null });
    const slots = (await call("GET", `/planning/slots?projectId=${batProject}&type=survey`)).json();
    expect(slots.slots).toHaveLength(0);
    expect(slots.message).toMatch(/installeert thuisbatterij/);
  });
});
