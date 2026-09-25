import { defineConfig, devices } from "@playwright/test";
import "dotenv/config";

const WEB_BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./src/e2e",
  fullyParallel: false, // shared seeded users/orgs — avoid cross-test session clobbering
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
