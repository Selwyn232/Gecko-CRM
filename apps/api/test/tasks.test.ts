import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIso } from "../src/lib/dates.js";
import { processOutbox } from "../src/modules/jobs/outbox.js";
import { addDays } from "../src/modules/planning/service.js";
import { adminSession, createTestContext, loginWithMfa, makeUser, type TestContext } from "./helpers.js";

let ctx: TestContext;
let h: Record<string, string>;
const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers = h) =>
  ctx.app.inject({ method, url: `/api${url}`, headers, payload: payload as object });

beforeAll(async () => {
  ctx = await createTestContext();
  h = (await adminSession(ctx)).headers;
});
afterAll(async () => ctx.close());

describe("taken en meldingen", () => {
  it("taak toewijzen geeft een melding; verschijnt bij Mijn werk; afvinken", async () => {
    const colleague = await makeUser(ctx.db, ["medewerker"]);
    const ch = (await loginWithMfa(ctx.app, colleague.email)).headers;
    const c = (await call("POST", "/customers", { lastName: "Taak", property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
    const t = await call("POST", "/tasks", { title: "Klant terugbellen", customerId: c.id, assigneeUserId: colleague.id, dueDate: addDays(todayIso(), -1) });
    expect(t.statusCode, t.body).toBe(201);

    const n = (await call("GET", "/notifications", undefined, ch)).json();
    expect(n.unread).toBe(1);
    expect(n.items[0]).toMatchObject({ title: "Nieuwe taak: Klant terugbellen", href: `/klanten/${c.id}` });
    await call("POST", "/notifications/all/read", undefined, ch);
    expect((await call("GET", "/notifications", undefined, ch)).json().unread).toBe(0);

    const work = (await call("GET", "/work", undefined, ch)).json();
    const section = work.sections.find((s: { key: string }) => s.key === "tasks");
    expect(section).toMatchObject({ severity: "high", count: 1 });

    expect((await call("GET", `/tasks?customerId=${c.id}&open=true`)).json()).toHaveLength(1);
    await call("PATCH", `/tasks/${t.json().id}`, { done: true }, ch);
    expect((await call("GET", `/tasks?customerId=${c.id}&open=true`)).json()).toHaveLength(0);
    // Alleen aan medewerkers van Gecko
    expect((await call("POST", "/tasks", { title: "x y", assigneeUserId: "00000000-0000-0000-0000-000000000000" })).json().error.code).toBe("invalid_assignee");
  });

  it("gebeurtenissen geven één melding, ook bij herhaalde verwerking", async () => {
    const c = (await call("POST", "/customers", { lastName: "Melding", email: "m@example.nl", property: { street: "Weg", houseNumber: "1", postalCode: "1234AB", city: "Ede" } })).json();
    // Minimale offerte → akkoord → event quote.accepted
    const groups = (await call("GET", "/product-groups")).json();
    const channels = (await call("GET", "/sales-channels")).json();
    const web = channels.find((x: { key: string }) => x.key === "web");
    const pkg = (await call("POST", "/products", { code: "MLD", name: "Pakket", productGroupId: groups[0].id, type: "package", vatCode: "hoog" })).json();
    await call("POST", `/products/${pkg.id}/sales-prices`, { scopeId: web.id, priceCents: 100_000, validFrom: todayIso() });
    const q = (await call("POST", "/quotes", { customerId: c.id, propertyId: c.properties[0].id, productGroupId: groups[0].id, salesChannelId: web.id })).json();
    await call("POST", `/quotes/${q.id}/lines`, { productId: pkg.id, quantity: 1 });
    await call("POST", `/quotes/${q.id}/send`);
    await call("POST", `/quotes/${q.id}/accept`, { acceptedByName: "M", method: "email" });
    await processOutbox(ctx.db, ctx.app.billing);
    await processOutbox(ctx.db, ctx.app.billing);
    const n = (await call("GET", "/notifications")).json();
    expect(n.items.filter((i: { href: string }) => i.href === `/offertes/${q.id}`)).toHaveLength(1);
  });
});
