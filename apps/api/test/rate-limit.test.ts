import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";

describe("rate limiting", () => {
  const config = { ...loadConfig(), RATE_LIMIT_ENABLED: true };
  const { db, pool } = createDb(config.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ config, db });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("blokkeert na 10 inlogpogingen per minuut", async () => {
    const attempt = () =>
      app.inject({ method: "POST", url: "/auth/login", payload: { email: "x@gecko.test", password: "y" } });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    const res = await attempt();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
  });
});
