import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  globalTeardown: "./test/cleanup-e2e.mjs",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:8310",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node test/start-e2e.mjs",
    url: "http://127.0.0.1:8310/healthz",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
