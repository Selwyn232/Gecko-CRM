import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { startScheduler } from "./modules/jobs/scheduler.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
// In productie serveert de API ook de gebouwde webapplicatie (apps/web/dist).
const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = await buildApp({ config, db, webDistDir: existsSync(webDistDir) ? webDistDir : undefined });

const stopJobs = config.JOBS_ENABLED ? startScheduler(db, app.billing, (msg, data) => app.log.info(data ?? {}, msg)) : () => {};
app.log.info({ paymentProvider: app.billing.paymentProvider.name, email: app.billing.emailTransport?.name ?? "uit" }, "Integraties");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Afsluiten");
  stopJobs();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
