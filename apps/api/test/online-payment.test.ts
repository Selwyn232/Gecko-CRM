import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { systemActor } from "../src/lib/context.js";
import { onlinePaymentAvailable, type BillingDeps } from "../src/modules/invoices/service.js";
import { setSetting } from "../src/modules/settings/service.js";
import { createTestContext, type TestContext } from "./helpers.js";

// B79: zonder Mollie geen knop "Betalen" voor klanten in productie (behalve in de testmodus).
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const deps = (provider: "test" | "mollie", env: "production" | "test"): BillingDeps =>
  ({ config: { ...loadConfig(), NODE_ENV: env }, emailTransport: null, paymentProvider: { name: provider } }) as unknown as BillingDeps;

describe("online betalen beschikbaar", () => {
  it("met Mollie altijd", async () => {
    expect(await onlinePaymentAvailable(ctx.db, deps("mollie", "production"))).toBe(true);
  });
  it("zonder Mollie in productie alleen in de testmodus", async () => {
    await setSetting(ctx.db, systemActor(), "test.mode", false);
    expect(await onlinePaymentAvailable(ctx.db, deps("test", "production"))).toBe(false);
    await setSetting(ctx.db, systemActor(), "test.mode", true);
    expect(await onlinePaymentAvailable(ctx.db, deps("test", "production"))).toBe(true);
    await setSetting(ctx.db, systemActor(), "test.mode", false);
  });
  it("buiten productie (ontwikkelen, tests) wel", async () => {
    expect(await onlinePaymentAvailable(ctx.db, deps("test", "test"))).toBe(true);
  });
});
