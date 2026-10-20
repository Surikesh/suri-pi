import { defineConfig, devices } from "@playwright/test";
const baseURL = `http://127.0.0.1:${process.env.SURI_E2E_PORT ?? "4310"}`;
const requestedWorkers = Number(process.env.SURI_E2E_WORKERS ?? "1");
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30000,
  fullyParallel: false,
  // The canonical test:e2e runner overrides this only for specs whose
  // browserHost fixture owns an isolated host, profile, workspace and port.
  workers:
    Number.isInteger(requestedWorkers) && requestedWorkers > 0
      ? requestedWorkers
      : 1,
  use: {
    actionTimeout: 10000,
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
