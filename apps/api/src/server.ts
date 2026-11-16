import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Afsluiten");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
