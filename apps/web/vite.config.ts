import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // In ontwikkeling stuurt Vite /api door naar de lokale API; in productie serveert de API deze app zelf.
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
});
