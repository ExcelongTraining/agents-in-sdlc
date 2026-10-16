import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
export const E2E_DB = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bk_e2e";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    ...devices["Pixel 7"], // mobile-first: every test runs at phone size
    // CI installs Chromium via `npx playwright install`; locally a browser can be pointed to with PLAYWRIGHT_CHROMIUM_PATH.
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: `npx next dev -p ${port}`,
    port,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: E2E_DB,
      APP_SECRET: "e2e-only-secret-e2e-only-secret-0123456789",
      APP_BASE_URL: `http://localhost:${port}`,
      WHATSAPP_PROVIDER: "mock",
      WHATSAPP_APP_SECRET: "e2e-wa-secret",
      WHATSAPP_VERIFY_TOKEN: "e2e-verify",
      CRON_SECRET: "e2e-cron-secret-0123456789",
      ORG_SLUG: "lotus-demo",
      NODE_ENV: "development",
    },
  },
});
