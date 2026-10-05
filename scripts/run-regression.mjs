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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNS_ROOT = path.join(ROOT, "test-results");

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

/** Recursively finds every screenshot Playwright wrote for this run (only exists on failure —
 * see playwright.config.ts's screenshot: "only-on-failure"), for linking from SUMMARY.html. */
function findScreenshots(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...findScreenshots(full));
    } else if (/\.(png|jpe?g)$/i.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const RELEASES = existsSync(path.join(ROOT, "test-releases.json"))
  ? JSON.parse(readFileSync(path.join(ROOT, "test-releases.json"), "utf-8"))
  : {};
const BASELINE = RELEASES.baseline ?? "baseline";

/** Which release introduced this test: a per-test title match wins over the per-file entry. */
function releaseFor(file, title) {
  for (const [needle, rel] of Object.entries(RELEASES.tests ?? {})) {
    if (title.includes(needle)) return rel;
  }
  const f = file.split(path.sep).join("/");
  const hit = Object.entries(RELEASES.files ?? {}).find(([k]) => f === k || f.endsWith(k));
  return hit ? hit[1] : BASELINE;
}

const stripAnsi = (t) => String(t ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const relFile = (f) => path.relative(ROOT, f);

/** Flattens Vitest's JSON reporter output into [{ file, title, status, durationMs, error }]. */
function readIntegrationTests(jsonPath) {
  if (!existsSync(jsonPath)) return [];
  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  return data.testResults.flatMap((f) =>
    f.assertionResults.map((a) => ({
      file: relFile(f.name),
      title: [...(a.ancestorTitles ?? []), a.title].join(" › "),
      status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
      durationMs: a.duration ?? 0,
      error: stripAnsi((a.failureMessages ?? []).join("\n\n")),
      release: releaseFor(relFile(f.name), [...(a.ancestorTitles ?? []), a.title].join(" › ")),
    })),
  );
}

/** Flattens Playwright's JSON reporter output the same way. */
function readE2eTests(jsonPath) {
  if (!existsSync(jsonPath)) return [];
  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const out = [];
  const walk = (suite, trail) => {
    const here = suite.title && !suite.file ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        const st = t.status === "expected" ? "passed" : t.status === "skipped" ? "skipped" : "failed";
        out.push({
          file: spec.file ?? suite.file ?? "",
          title: [...here, spec.title].join(" › "),
          status: st,
          durationMs: (t.results ?? []).reduce((n, r) => n + (r.duration ?? 0), 0),
          error: stripAnsi(last?.error?.message ?? ""),
          release: releaseFor(spec.file ?? suite.file ?? "", [...here, spec.title].join(" › ")),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of data.suites ?? []) walk(s, []);
  return out;
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

/** First meaningful line of a failure, for the at-a-glance view (full text stays in <details>). */
function firstErrorLine(err) {
  const line = String(err ?? "").split("\n").map((l) => l.trim()).find((l) => l && !/^at\s/.test(l));
  return line ? line.slice(0, 220) : "";
}

const shortFile = (f) => String(f).replace(/^src\/(integration|e2e)\//, "");

function testsSection(tests, suiteId) {
  if (!tests.length) return `<p class="skipped">No per-test data available.</p>`;
  const count = (st) => tests.filter((t) => t.status === st).length;
  const failed = tests.filter((t) => t.status === "failed");
  const icon = { passed: "✓", failed: "✗", skipped: "–" };

  const row = (t) => {
    const parts = t.title.split(" › ");
    const name = parts.pop();
    const group = parts.join(" › ");
    return `<li class="t ${t.status}">
      <span class="ic">${icon[t.status]}</span>
      <div class="tb">
        <div class="tn">${escapeHtml(name)}${t.release !== BASELINE ? ` <span class="rel new" title="introduced in ${escapeHtml(t.release)}">new</span>` : ""}</div>
        ${t.status === "failed" ? `<div class="err">${escapeHtml(firstErrorLine(t.error))}</div>` : ""}
        ${t.status === "failed" && t.error ? `<details><summary>Full failure details</summary><pre>${escapeHtml(t.error)}</pre></details>` : ""}
      </div>
      <span class="tt">${fmtMs(t.durationMs)}</span>
    </li>`;
  };

  // Group by file, failing files first, then alphabetically.
  const byFile = new Map();
  for (const t of tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push(t);
  }
  const files = [...byFile.entries()].sort(([fa, ta], [fb, tb]) => {
    const fail = (l) => l.some((x) => x.status === "failed") ? 0 : 1;
    return fail(ta) - fail(tb) || fa.localeCompare(fb);
  });

  const fileBlocks = files
    .map(([file, list]) => {
      const nf = list.filter((x) => x.status === "failed").length;
      const np = list.filter((x) => x.status === "passed").length;
      const ns = list.filter((x) => x.status === "skipped").length;
      const ordered = [...list].sort((x, y) => (x.status === "failed" ? 0 : 1) - (y.status === "failed" ? 0 : 1));
      return `<details class="file ${nf ? "has-fail" : ""}" ${nf ? "open" : ""}>
        <summary><span class="fname">${escapeHtml(shortFile(file))}</span>
          <span class="fcount">${nf ? `<b class="fail">${nf} failed</b> · ` : ""}${np} passed${ns ? ` · ${ns} skipped` : ""}</span></summary>
        <ul class="tests">${ordered.map(row).join("\n")}</ul>
      </details>`;
    })
    .join("\n");

  const fresh = failed.filter((t) => t.release !== BASELINE).length;
  const note = !failed.length
    ? ""
    : fresh
      ? `<p class="note fail">${fresh} failure${fresh === 1 ? "" : "s"} in tests introduced in this release — fix before deploying.</p>`
      : `<p class="note">All ${failed.length} failures are in pre-existing tests (none in tests introduced in this release).</p>`;

  return `<div class="counts"><span class="badge pass">${count("passed")} passed</span> <span class="badge fail">${count("failed")} failed</span> <span class="badge skip">${count("skipped")} skipped</span>
    <span class="meta">· ${fmtMs(tests.reduce((n, t) => n + t.durationMs, 0))} total</span></div>
    ${note}
    <div class="filebar"><span class="meta">${files.length} files</span> <button type="button" onclick="toggleAll('${suiteId}', true)">Expand all</button> <button type="button" onclick="toggleAll('${suiteId}', false)">Collapse all</button></div>
    <div id="${suiteId}">${fileBlocks}</div>`;
}

function buildHtmlSummary({
  runId,
  version,
  generatedAt,
  skipIntegration,
  skipE2e,
  integrationStatus,
  integrationSummary,
  integrationTests,
  e2eStatus,
  e2eTests,
  screenshots,
  runDir,
}) {
  const overallOk =
    (skipIntegration || integrationSummary?.success) && (skipE2e || e2eStatus === 0);
  const badge = (ok) => `<span class="badge ${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"}</span>`;

  const integrationSection = skipIntegration
    ? `<p class="skipped">Skipped</p>`
    : integrationSummary
      ? `<p>${badge(integrationSummary.success)} &middot; <a href="integration/results.json">raw results (JSON)</a></p>${testsSection(integrationTests, "integration-files")}`
      : `<p class="fail">Exit code ${integrationStatus} — no results.json found, check console output.</p>`;

  const e2eSection = skipE2e
    ? `<p class="skipped">Skipped</p>`
    : `<p>${badge(e2eStatus === 0)} (exit code ${e2eStatus}) &middot; <a href="e2e/playwright-report/index.html">Playwright HTML report</a></p>
       ${testsSection(e2eTests, "e2e-files")}
       ${
         screenshots.length
           ? `<h3>Failure screenshots (${screenshots.length})</h3>
              <div class="shots">${screenshots
                .map((s) => {
                  const rel = path.relative(runDir, s);
                  return `<figure><a href="${rel}"><img src="${rel}" loading="lazy" /></a><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
                })
                .join("\n")}</div>`
           : `<p>No failure screenshots (screenshots are only captured on failure).</p>`
       }`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Regression report — ${escapeHtml(runId)}</title>
<style>
  :root { color-scheme: light dark; --bd: #8884; --mut: #777; --ok: #16a34a; --bad: #dc2626; --card: #8881; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1.25rem 4rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 0.75rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--bd); display: flex; align-items: center; gap: 0.6rem; }
  h3 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
  .meta { color: var(--mut); font-size: 0.85rem; }
  .badge { display: inline-block; padding: 0.12rem 0.65rem; border-radius: 999px; font-weight: 600; font-size: 0.8rem; }
  .badge.pass { background: #16a34a22; color: var(--ok); } .badge.fail { background: #dc262622; color: var(--bad); } .badge.skip { background: #8882; color: var(--mut); }
  .skipped { color: var(--mut); font-style: italic; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; margin: 1.25rem 0; }
  .card { background: var(--card); border: 1px solid var(--bd); border-radius: 10px; padding: 0.9rem 1rem; }
  .card .k { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--mut); }
  .card .v { font-size: 1.6rem; font-weight: 700; line-height: 1.2; } .card .v.bad { color: var(--bad); } .card .v.ok { color: var(--ok); }
  .card .s { font-size: 0.8rem; color: var(--mut); }
  .counts { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .note { margin: 0.75rem 0; padding: 0.6rem 0.9rem; border-left: 3px solid var(--mut); background: var(--card); border-radius: 4px; font-size: 0.9rem; }
  .note.fail { border-color: var(--bad); }
  .filebar { display: flex; gap: 0.5rem; align-items: center; margin: 1rem 0 0.5rem; }
  .filebar button { font: inherit; font-size: 0.78rem; padding: 0.15rem 0.6rem; border: 1px solid var(--bd); background: transparent; color: inherit; border-radius: 6px; cursor: pointer; }
  details.file { border: 1px solid var(--bd); border-radius: 8px; margin: 0.4rem 0; background: transparent; }
  details.file.has-fail { border-color: #dc262666; }
  details.file > summary { cursor: pointer; padding: 0.55rem 0.8rem; display: flex; justify-content: space-between; gap: 1rem; list-style: none; }
  details.file > summary::-webkit-details-marker { display: none; }
  details.file > summary::before { content: "▸"; color: var(--mut); margin-right: 0.5rem; }
  details.file[open] > summary::before { content: "▾"; }
  .fname { font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; flex: 1; word-break: break-all; }
  .fcount { font-size: 0.8rem; color: var(--mut); white-space: nowrap; } b.fail { color: var(--bad); }
  ul.tests { list-style: none; margin: 0; padding: 0 0.8rem 0.5rem; }
  li.t { display: flex; gap: 0.6rem; padding: 0.4rem 0; border-top: 1px solid #8882; align-items: flex-start; font-size: 0.88rem; }
  li.t .ic { width: 1rem; font-weight: 700; flex: none; } li.passed .ic { color: var(--ok); } li.failed .ic { color: var(--bad); } li.skipped .ic { color: var(--mut); }
  li.t .tb { flex: 1; min-width: 0; } li.t .tn { overflow-wrap: anywhere; } li.failed .tn { font-weight: 600; }
  li.t .tt { color: var(--mut); font-size: 0.78rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .err { color: var(--bad); font-size: 0.8rem; margin-top: 0.15rem; overflow-wrap: anywhere; }
  .rel.new { font-size: 0.68rem; padding: 0.05rem 0.4rem; border-radius: 999px; background: #2563eb22; color: #2563eb; vertical-align: middle; }
  details:not(.file) { margin-top: 0.3rem; } details:not(.file) summary { cursor: pointer; color: var(--mut); font-size: 0.78rem; }
  pre { white-space: pre-wrap; background: var(--card); padding: 0.6rem; border-radius: 6px; font-size: 0.75rem; max-height: 20rem; overflow: auto; }
  .shots { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.5rem; }
  .shots figure { margin: 0; width: 240px; } .shots img { width: 100%; border: 1px solid var(--bd); border-radius: 6px; display: block; }
  .shots figcaption { font-size: 0.72rem; color: var(--mut); margin-top: 0.25rem; word-break: break-all; }
  a { color: #2563eb; }
</style>
<script>
  function toggleAll(id, open) { document.querySelectorAll('#' + id + ' details.file').forEach(function (d) { d.open = open; }); }
</script>
</head>
<body>
  <h1>Regression report ${badge(overallOk)}</h1>
  <p class="meta">Release <strong>${escapeHtml(version)}</strong> &middot; ${escapeHtml(generatedAt)} &middot; run ${escapeHtml(runId)}</p>

  <div class="cards">
    <div class="card"><div class="k">Integration (API)</div>
      <div class="v ${integrationSummary && !integrationSummary.success ? "bad" : "ok"}">${skipIntegration ? "Skipped" : integrationSummary ? `${integrationSummary.numPassedTests} / ${integrationSummary.numTotalTests}` : "No data"}</div>
      <div class="s">${integrationSummary ? `${integrationSummary.numFailedTests} failed · ${integrationSummary.numPendingTests ?? 0} skipped` : ""}</div></div>
    <div class="card"><div class="k">E2E (browser)</div>
      <div class="v ${e2eStatus === 0 ? "ok" : "bad"}">${skipE2e ? "Skipped" : `${e2eTests.filter((t) => t.status === "passed").length} / ${e2eTests.length}`}</div>
      <div class="s">${skipE2e ? "" : `${e2eTests.filter((t) => t.status === "failed").length} failed · <a href="e2e/playwright-report/index.html">Playwright report</a>`}</div></div>
  </div>

  <h2>Integration suite <span class="meta">Vitest, API-level</span></h2>
  ${integrationSection}

  <h2>E2E suite <span class="meta">Playwright, browser-level</span></h2>
  ${e2eSection}
</body>
</html>
`;
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

function rebuildReport(runId) {
  const runDir = path.join(RUNS_ROOT, runId);
  if (!existsSync(runDir)) {
    console.error(`No such run: ${path.relative(ROOT, runDir)}`);
    process.exit(1);
  }
  const integrationSummary = summarizeIntegrationResults(path.join(runDir, "integration", "results.json"));
  const e2eJson = path.join(runDir, "e2e", "results.json");
  const e2eTests = readE2eTests(e2eJson);
  const html = buildHtmlSummary({
    runId,
    version: runId.replace(/_\d{4}-.*$/, ""),
    generatedAt: new Date().toISOString(),
    skipIntegration: !integrationSummary,
    skipE2e: !existsSync(path.join(runDir, "e2e")),
    integrationStatus: integrationSummary?.success ? 0 : 1,
    integrationSummary,
    integrationTests: readIntegrationTests(path.join(runDir, "integration", "results.json")),
    e2eStatus: e2eTests.some((t) => t.status === "failed") ? 1 : 0,
    e2eTests,
    screenshots: findScreenshots(path.join(runDir, "e2e", "test-results")),
    runDir,
  });
  writeFileSync(path.join(runDir, "SUMMARY.html"), html);
  console.log(`Rebuilt ${path.relative(ROOT, path.join(runDir, "SUMMARY.html"))}`);
}

async function main() {
  const rebuild = args.find((a) => a.startsWith("--rebuild="));
  if (rebuild) return rebuildReport(rebuild.split("=")[1]);
  const version = sanitize(await promptVersion());
  const runId = `${version}_${timestamp()}`;
  const runDir = path.join(RUNS_ROOT, runId);
  mkdirSync(path.join(runDir, "integration"), { recursive: true });
  mkdirSync(path.join(runDir, "e2e"), { recursive: true });

  console.log(`\nRegression run: ${runId}`);
  console.log(`Artifacts will be written to: ${path.relative(ROOT, runDir)}/`);

  // Cached logins can carry state a previous run mutated (e.g. a nulled active organization),
  // which then fails every later run. Start each regression from fresh sign-ins.
  rmSync(path.join(ROOT, ".qa-cache"), { recursive: true, force: true });

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

  const screenshots = skipE2e ? [] : findScreenshots(path.join(runDir, "e2e", "test-results"));
  const htmlSummary = buildHtmlSummary({
    runId,
    version,
    generatedAt: new Date().toISOString(),
    skipIntegration,
    skipE2e,
    integrationStatus,
    integrationSummary,
    integrationTests: readIntegrationTests(path.join(runDir, "integration", "results.json")),
    e2eStatus,
    e2eTests: readE2eTests(path.join(runDir, "e2e", "results.json")),
    screenshots,
    runDir,
  });
  writeFileSync(path.join(runDir, "SUMMARY.html"), htmlSummary);

  // Point a stable "latest" file at this run so it's easy to find without hunting by timestamp.
  writeFileSync(path.join(RUNS_ROOT, "LATEST"), runId + "\n");

  console.log(`\n=== Regression run ${runId} complete ===`);
  console.log(`HTML report: ${path.relative(ROOT, path.join(runDir, "SUMMARY.html"))}`);
  console.log(`Markdown summary: ${path.relative(ROOT, path.join(runDir, "SUMMARY.md"))}`);
  if (!skipE2e && existsSync(htmlReportIndex)) {
    console.log(
      `E2e HTML report: npx playwright show-report ${path.relative(ROOT, path.join(runDir, "e2e", "playwright-report"))}`,
    );
  }
  if (screenshots.length) {
    console.log(`Failure screenshots: ${screenshots.length} (linked from SUMMARY.html)`);
  }

  const overallStatus = (skipIntegration ? 0 : integrationStatus) || (skipE2e ? 0 : e2eStatus);
  process.exit(overallStatus ? 1 : 0);
}

main();
