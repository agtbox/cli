import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { hasNonPublicGitHubReference } from "./public-reference.mjs";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !statSync(root).isDirectory()) {
  console.error("usage: node scripts/scan-unpacked-package.mjs <unpacked-package-directory>");
  process.exit(2);
}

function filesBelow(current) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(current, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

const pathRules = [
  [/\.map$/i, "source map"],
  [/(^|\/)(?:\.env(?:\..*)?|\.env\.keys)(?:$|\/)/i, "environment-secret path"],
  [/(^|\/)(?:infra|pulumi|worker|store)(?:$|\/|\.)/i, "private implementation path"],
];
const contentRules = [
  [/\bsourcesContent\b|sourceMappingURL=/i, "embedded source map"],
  [/(?:\/(?:home|Users)\/[^\s"']+|[A-Z]:\\Users\\[^\s"']+)/, "private workspace path"],
  [/\b(?:cfat|cfut)_[A-Za-z0-9_-]+\b/, "Cloudflare credential prefix"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
  [/\b0x[a-fA-F0-9]{64}\b/, "private-key-shaped hexadecimal value"],
  [/\b(?:api[_-]?key|secret|token|private[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,}/i, "assigned credential-shaped value"],
];

const findings = [];
const prohibitedTokenHashes = new Set([
  "0c1947d6df797426e38d0dcbeea12196b9e5ccd89e38e80ce145bce67861d7ff",
  "884998e0acc403763c0a96ec3dbb1035ac3fed150d5e6320003536c381d5e6f0",
  "c12a1492920c8780b98bb44598d34c9621c8e8314992c47e0d34a2af98150de8",
]);
for (const absolute of filesBelow(root)) {
  const path = relative(root, absolute).replaceAll("\\", "/");
  for (const [pattern, label] of pathRules) {
    if (pattern.test(path)) findings.push(`${path}: ${label}`);
  }
  for (const token of path.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
    const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
    if (prohibitedTokenHashes.has(digest)) findings.push(`${path}: prohibited private brand or operator token in path`);
  }

  const bytes = readFileSync(absolute);
  const content = bytes.toString("latin1");
  for (const [pattern, label] of contentRules) {
    if (pattern.test(content)) findings.push(`${path}: ${label}`);
  }
  if (hasNonPublicGitHubReference(content)) findings.push(`${path}: non-public repository reference`);
  for (const token of content.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
    const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
    if (prohibitedTokenHashes.has(digest)) findings.push(`${path}: prohibited private brand or operator token`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log("unpacked package contains no prohibited paths or content patterns");
