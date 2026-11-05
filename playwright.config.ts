import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser", fullyParallel: false, workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:8789", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: { command: "node scripts/browser-server.mjs", url: "http://127.0.0.1:8789",
    reuseExistingServer: false, timeout: 120000 },
});
