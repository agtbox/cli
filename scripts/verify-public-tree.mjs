import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hasNonPublicGitHubReference } from "./public-reference.mjs";

const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules", "release-artifacts"]);
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function filesBelow(root, symbolicLinks, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return [];
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) return filesBelow(root, symbolicLinks, absolute);
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) symbolicLinks.push(path);
    return [path];
  });
}

const root = resolve(argument("--root", process.cwd()));
const allowlistPath = resolve(argument("--allowlist", resolve(root, "release/public-files.json")));
const filesystemFixture = process.argv.includes("--filesystem-fixture");
const membership = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
const isGitRepository = membership.status === 0 && membership.stdout.trim() === "true";
if (!filesystemFixture && !isGitRepository) {
  console.error("public-tree verification requires a Git repository; filesystem mode is test-only");
  process.exit(1);
}
const indexResult = spawnSync("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "utf8" });
const indexEntries = indexResult.status === 0
  ? indexResult.stdout.split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error(`cannot parse Git index entry: ${entry}`);
    return { mode: match[1], object: match[2], stage: match[3], path: match[4] };
  })
  : [];
const usesIndex = isGitRepository && !filesystemFixture;
if (usesIndex && indexEntries.length === 0) {
  console.error("public Git index is empty; stage the exact candidate before verification");
  process.exit(1);
}
const allowlistRelative = relative(root, allowlistPath).replaceAll("\\", "/");
const allowlistEntry = indexEntries.find(({ path, stage }) => path === allowlistRelative && stage === "0");
const allowlistBytes = usesIndex && allowlistEntry
  ? spawnSync("git", ["-C", root, "cat-file", "blob", allowlistEntry.object]).stdout
  : readFileSync(allowlistPath);
const allowed = new Set(JSON.parse(allowlistBytes.toString("utf8")));
const symbolicLinks = [];
const actual = usesIndex
  ? indexEntries.map(({ path }) => path).sort()
  : filesBelow(root, symbolicLinks).sort();
if (usesIndex) {
  symbolicLinks.push(...indexEntries.filter(({ mode }) => mode === "120000").map(({ path }) => path));
}
const unlisted = actual.filter((file) => !allowed.has(file));
const missing = [...allowed].filter((file) => !actual.includes(file));
const findings = [];

if (usesIndex) {
  for (const entry of indexEntries) {
    if (entry.stage !== "0") findings.push(`unmerged Git index entry is prohibited: ${entry.path}`);
    if (entry.mode === "160000") findings.push(`Git submodules are prohibited in the public tree: ${entry.path}`);
  }
  const worktreeDiff = spawnSync("git", ["-C", root, "diff", "--quiet", "--"]);
  if (worktreeDiff.status !== 0) findings.push("working-tree content differs from the staged public candidate");
  const untracked = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    if (!IGNORED_DIRECTORIES.has(path.split("/")[0])) findings.push(`unstaged public candidate file: ${path}`);
  }
}

const repositoryRules = [
  [/(?:\/(?:home|Users)\/[^\s"']+|[A-Z]:\\Users\\[^\s"']+)/, "private workspace path"],
  [/\b(?:cfat|cfut)_[A-Za-z0-9_-]+\b/, "Cloudflare credential prefix"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
  [/\b0x[a-fA-F0-9]{64}\b/, "private-key-shaped hexadecimal value"],
  [/\b(?:api[_-]?key|secret|token|private[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,}/i, "assigned credential-shaped value"],
];
const prohibitedTokenHashes = new Set([
  "0c1947d6df797426e38d0dcbeea12196b9e5ccd89e38e80ce145bce67861d7ff",
  "884998e0acc403763c0a96ec3dbb1035ac3fed150d5e6320003536c381d5e6f0",
  "c12a1492920c8780b98bb44598d34c9621c8e8314992c47e0d34a2af98150de8",
]);
for (const path of actual) {
  for (const token of path.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
    const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
    if (prohibitedTokenHashes.has(digest)) findings.push(`prohibited private brand or operator token in path: ${path}`);
  }
  const entry = indexEntries.find((candidate) => candidate.path === path && candidate.stage === "0");
  const bytes = entry
    ? spawnSync("git", ["-C", root, "cat-file", "blob", entry.object]).stdout
    : readFileSync(resolve(root, path));
  const content = bytes.toString("latin1");
  for (const [pattern, label] of repositoryRules) {
    if (pattern.test(content)) findings.push(`${label} in ${path}`);
  }
  if (hasNonPublicGitHubReference(content)) findings.push(`non-public repository reference in ${path}`);
  for (const token of content.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
    const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
    if (prohibitedTokenHashes.has(digest)) findings.push(`prohibited private brand or operator token in ${path}`);
  }
}

if (unlisted.length > 0 || missing.length > 0 || symbolicLinks.length > 0 || findings.length > 0) {
  for (const file of unlisted) console.error(`not present in the public-file allowlist: ${file}`);
  for (const file of missing) console.error(`allowlisted public file is missing: ${file}`);
  for (const file of symbolicLinks) console.error(`symbolic links are prohibited in the public tree: ${file}`);
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log(`verified ${actual.length} public repository files against the positive allowlist`);
