import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-env.ts"],
    // Alle tests delen één testdatabase; sequentieel draaien voorkomt interferentie.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
