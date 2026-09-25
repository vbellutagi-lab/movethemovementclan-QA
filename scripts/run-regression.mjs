#!/usr/bin/env node
// Runs the full regression suite (integration + e2e) for a given version/release label and
// files everything — Playwright's HTML report, failure screenshots/traces/video, and the
// integration suite's JSON results — under one versioned, timestamped folder so nothing gets
// overwritten by the next run and it's obvious which run is which.
//
// Usage:
//   npm run regression                  # prompts for a version label
//   npm run regression -- v1.2.0        # skips the prompt
//   npm run regression -- --skip-integration
//   npm run regression -- --skip-e2e

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNS_ROOT = path.join(ROOT, "regression-runs");

const args = process.argv.slice(2);
const skipIntegration = args.includes("--skip-integration");
const skipE2e = args.includes("--skip-e2e");
const positional = args.find((a) => !a.startsWith("--"));

function sanitize(label) {
  return label
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unversioned";
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function promptVersion() {
  if (positional) return positional;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    "Which version/release is this regression run for? (e.g. v1.2.0, pre-release-2026-09-25): ",
  );
  rl.close();
  if (!answer.trim()) {
    console.error("A version label is required.");
    process.exit(1);
  }
  return answer;
}

function run(label, command, args, env) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

function summarizeIntegrationResults(jsonPath) {
  if (!existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
    return {
      numTotalTests: data.numTotalTests,
      numPassedTests: data.numPassedTests,
      numFailedTests: data.numFailedTests,
      numPendingTests: data.numPendingTests,
      success: data.success,
    };
  } catch {
    return null;
  }
}

async function main() {
  const version = sanitize(await promptVersion());
  const runId = `${version}_${timestamp()}`;
  const runDir = path.join(RUNS_ROOT, runId);
  mkdirSync(path.join(runDir, "integration"), { recursive: true });
  mkdirSync(path.join(runDir, "e2e"), { recursive: true });

  console.log(`\nRegression run: ${runId}`);
  console.log(`Artifacts will be written to: ${path.relative(ROOT, runDir)}/`);

  const env = { REGRESSION_RUN_DIR: runDir, QA_AUTOWAIT_RATE_LIMIT: "true" };

  let integrationStatus = 0;
  if (!skipIntegration) {
    integrationStatus = run(
      "Integration suite (Vitest, API-level)",
      "npx",
      ["vitest", "run", "--config", "vitest.regression.config.ts"],
      env,
    );
  } else {
    console.log("\n(skipping integration suite: --skip-integration)");
  }

  let e2eStatus = 0;
  if (!skipE2e) {
    e2eStatus = run("E2e suite (Playwright, browser-level)", "npx", ["playwright", "test"], env);
  } else {
    console.log("\n(skipping e2e suite: --skip-e2e)");
  }

  const integrationSummary = summarizeIntegrationResults(
    path.join(runDir, "integration", "results.json"),
  );

  const htmlReportIndex = path.join(runDir, "e2e", "playwright-report", "index.html");
  const summaryLines = [
    `# Regression run: ${runId}`,
    "",
    `- Version/release: ${version}`,
    `- Date/time: ${new Date().toISOString()}`,
    "",
    "## Integration suite (Vitest, API-level)",
    skipIntegration
      ? "- Skipped"
      : integrationSummary
        ? [
            `- Total: ${integrationSummary.numTotalTests}`,
            `- Passed: ${integrationSummary.numPassedTests}`,
            `- Failed: ${integrationSummary.numFailedTests}`,
            `- Pending: ${integrationSummary.numPendingTests}`,
            `- Result: ${integrationSummary.success ? "PASS" : "FAIL"}`,
            `- Raw results: integration/results.json`,
          ].join("\n")
        : `- Exit code: ${integrationStatus} (no results.json found — check console output above)`,
    "",
    "## E2e suite (Playwright, browser-level)",
    skipE2e
      ? "- Skipped"
      : [
          `- Exit code: ${e2eStatus} (${e2eStatus === 0 ? "PASS" : "FAIL"})`,
          `- HTML report: e2e/playwright-report/index.html`,
          `  Open with: npx playwright show-report ${path.relative(ROOT, path.join(runDir, "e2e", "playwright-report"))}`,
          `- Failure screenshots/traces/video: e2e/test-results/`,
        ].join("\n"),
    "",
  ];
  writeFileSync(path.join(runDir, "SUMMARY.md"), summaryLines.join("\n"));

  // Point a stable "latest" file at this run so it's easy to find without hunting by timestamp.
  writeFileSync(path.join(RUNS_ROOT, "LATEST"), runId + "\n");

  console.log(`\n=== Regression run ${runId} complete ===`);
  console.log(`Summary: ${path.relative(ROOT, path.join(runDir, "SUMMARY.md"))}`);
  if (!skipE2e && existsSync(htmlReportIndex)) {
    console.log(
      `E2e HTML report: npx playwright show-report ${path.relative(ROOT, path.join(runDir, "e2e", "playwright-report"))}`,
    );
  }

  const overallStatus = (skipIntegration ? 0 : integrationStatus) || (skipE2e ? 0 : e2eStatus);
  process.exit(overallStatus ? 1 : 0);
}

main();
