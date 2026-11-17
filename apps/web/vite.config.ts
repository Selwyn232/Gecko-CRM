import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Versie van deze build: de commit (Render zet RENDER_GIT_COMMIT tijdens de build), anders het bouwtijdstip.
 * Zit in de app (__APP_VERSION__) én in dist/version.json; een open scherm vergelijkt die twee
 * en meldt "nieuwe versie beschikbaar" na een deploy (components/UpdateBar.tsx).
 */
const version = process.env.RENDER_GIT_COMMIT?.slice(0, 12) || new Date().toISOString();

const versionFile = (): Plugin => ({
  name: "gecko-version-file",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version }) });
  },
});

export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // In ontwikkeling stuurt Vite /api door naar de lokale API; in productie serveert de API deze app zelf.
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
});
