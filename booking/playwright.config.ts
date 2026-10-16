import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", ...devices["Pixel 7"],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined } },
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: `npx next dev -p ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? "",
      APP_SECRET: "e2e-only-secret-e2e-only-secret-0123456789",
      APP_BASE_URL: `http://localhost:${port}`,
      WHATSAPP_PROVIDER: "mock",
      CRON_SECRET: "e2e-cron-secret",
      NODE_ENV: "development",
    },
  },
});
