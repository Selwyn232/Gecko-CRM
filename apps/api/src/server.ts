import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
// In productie serveert de API ook de gebouwde webapplicatie (apps/web/dist).
const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = await buildApp({ config, db, webDistDir: existsSync(webDistDir) ? webDistDir : undefined });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Afsluiten");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: "0.0.0.0" });
