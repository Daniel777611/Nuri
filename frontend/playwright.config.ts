import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "login-recommendations.spec.ts",
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  forbidOnly: Boolean(process.env.CI),
  outputDir: "test-results",
  use: {
    baseURL:
      process.env.NURI_E2E_BASE_URL ||
      "https://nuri-test-ordashtech.vercel.app",
    browserName: "chromium",
    channel: process.env.NURI_E2E_BROWSER_CHANNEL || "chrome",
    headless: process.env.NURI_E2E_HEADED !== "1",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
