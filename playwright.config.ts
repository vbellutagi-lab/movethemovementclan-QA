import { defineConfig, devices } from "@playwright/test";
import "dotenv/config";

const WEB_BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:3000";

// Set by scripts/run-regression.mjs so a given regression run's HTML report and
// failure artifacts (screenshots/traces/video) land under one versioned, timestamped
// folder instead of overwriting playwright-report/ and test-results/ on every run.
const RUN_DIR = process.env.REGRESSION_RUN_DIR;
const outputDir = RUN_DIR ? `${RUN_DIR}/e2e/test-results` : "./test-results";
const htmlReportDir = RUN_DIR ? `${RUN_DIR}/e2e/playwright-report` : "./playwright-report";

export default defineConfig({
  testDir: "./src/e2e",
  outputDir,
  fullyParallel: false, // shared seeded users/orgs — avoid cross-test session clobbering
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: htmlReportDir }]],
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
