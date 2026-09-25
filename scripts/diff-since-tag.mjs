#!/usr/bin/env node
// Summarizes what changed in the app repo (movethemovementclan) between a given tag and a
// branch (default: develop) — commit log + changed-files stat — so a new feature's scope can
// be reviewed before writing new test cases for it in this QA repo. This does NOT write test
// cases itself; it just produces the material to review (with Claude, or by hand).
//
// Usage:
//   npm run diff:since-tag -- v1.1.0
//   npm run diff:since-tag -- v1.1.0 --branch=feature/client-session-stats
//   npm run diff:since-tag -- v1.1.0 --app-repo=/path/to/movethemovementclan

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith("--"));
const branchArg = args.find((a) => a.startsWith("--branch="));
const appRepoArg = args.find((a) => a.startsWith("--app-repo="));

const branch = branchArg ? branchArg.split("=")[1] : "develop";
const appRepo = appRepoArg
  ? path.resolve(appRepoArg.split("=")[1])
  : process.env.APP_REPO_PATH
    ? path.resolve(process.env.APP_REPO_PATH)
    : path.resolve(ROOT, "..", "movethemovementclan");

if (!tag) {
  console.error("Usage: npm run diff:since-tag -- <tag> [--branch=develop] [--app-repo=/path]");
  process.exit(1);
}

if (!existsSync(appRepo)) {
  console.error(
    `App repo not found at ${appRepo}. Set --app-repo=/path or APP_REPO_PATH in the environment.`,
  );
  process.exit(1);
}

function git(gitArgs) {
  return execFileSync("git", ["-C", appRepo, ...gitArgs], { encoding: "utf-8" });
}

let commits, stat, tagExists, branchExists;
try {
  tagExists = git(["tag", "--list", tag]).trim() === tag;
} catch {
  tagExists = false;
}
if (!tagExists) {
  console.error(`Tag "${tag}" not found in ${appRepo}. Available tags:\n${git(["tag"])}`);
  process.exit(1);
}

try {
  branchExists = git(["rev-parse", "--verify", "--quiet", branch]).trim().length > 0;
} catch {
  branchExists = false;
}
if (!branchExists) {
  console.error(`Branch/ref "${branch}" not found in ${appRepo}.`);
  process.exit(1);
}

commits = git(["log", `${tag}..${branch}`, "--oneline", "--no-merges"]).trim();
stat = git(["diff", `${tag}..${branch}`, "--stat"]).trim();
const filesOnly = git(["diff", `${tag}..${branch}`, "--name-only"]).trim();

const date = new Date().toISOString().slice(0, 10);
const outDir = path.join(ROOT, "docs", "change-summaries");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${tag}-to-${branch.replace(/\//g, "-")}-${date}.md`);

const lines = [
  `# Change summary: ${tag} → ${branch}`,
  "",
  `- App repo: ${appRepo}`,
  `- Generated: ${new Date().toISOString()}`,
  "",
  "## Commits (no merges)",
  "```",
  commits || "(none)",
  "```",
  "",
  "## Changed files (stat)",
  "```",
  stat || "(none)",
  "```",
  "",
  "## Next step",
  "Review the commits/files above, group them into features, then ask Claude to draft new",
  "test cases in src/integration/ and/or src/e2e/ for each feature area touched.",
  "",
];

writeFileSync(outPath, lines.join("\n"));

console.log(lines.join("\n"));
console.log(`\nSaved: ${path.relative(ROOT, outPath)}`);
console.log(`(${filesOnly.split("\n").filter(Boolean).length} files changed)`);
