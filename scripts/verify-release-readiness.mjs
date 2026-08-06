import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const notice = readFileSync(resolve(root, "NOTICE"), "utf8");
const license = readFileSync(resolve(root, "LICENSE"));
const findings = [];

if (packageJson.name !== "@agtbox/cli") findings.push("package name must be @agtbox/cli");
if (packageJson.private !== false) findings.push("package must set private to false");
if (packageJson.license !== "PolyForm-Shield-1.0.0") findings.push("package license must be PolyForm-Shield-1.0.0");
if (createHash("sha256").update(license).digest("hex") !== "56328093d57c87dcf2811ddcc824caf2723a07ffc332e6fbe4f9f108a2893a91") {
  findings.push("LICENSE must be the exact unmodified PolyForm Shield 1.0.0 text");
}
if (!packageJson.version || packageJson.version.includes("development")) findings.push("package version must be a release version");
if (packageJson.bin?.agentbox !== "dist/agentbox.js") findings.push("package must expose the agentbox executable at dist/agentbox.js");
if (packageJson.repository?.url !== "git+https://github.com/agtbox/cli.git") findings.push("package repository must be the public agtbox/cli repository");
if (packageJson.bugs?.url !== "https://github.com/agtbox/cli/issues") findings.push("package bugs URL must be the public agtbox/cli issue tracker");
if (packageJson.publishConfig?.access !== "public") findings.push("package publishConfig.access must be public");
if (!packageJson.engines?.node || !packageJson.engines?.bun) findings.push("package must declare supported Node and Bun runtime ranges");

const allowedScripts = new Set([
  "build:release", "lint", "test", "typecheck",
  "verify:authors", "verify:package", "verify:public-tree", "verify:scaffold", "verify:third-party",
  "release:artifact", "release:readiness",
]);
for (const script of Object.keys(packageJson.scripts ?? {})) {
  if (!allowedScripts.has(script)) findings.push(`package lifecycle script is prohibited: ${script}`);
}
if (typeof packageJson.scripts?.["build:release"] !== "string") findings.push("package must define the reviewed build:release command");

const executable = resolve(root, "dist/agentbox.js");
if (!existsSync(executable)) {
  findings.push("compiled CLI entrypoint is missing: dist/agentbox.js");
} else {
  const content = readFileSync(executable, "utf8");
  if (!content.startsWith("#!/usr/bin/env node\n")) findings.push("compiled CLI entrypoint must have the Node shebang");
  if ((statSync(executable).mode & 0o111) === 0) findings.push("compiled CLI entrypoint must be executable");
}

const requiredNoticeLines = notice.split("\n").filter((line) => line.startsWith("Required Notice:"));
if (requiredNoticeLines.length !== 1) findings.push("NOTICE must contain exactly one Required Notice line");
if (notice.includes("<LEGAL NAME")) findings.push("NOTICE still contains the copyright owner placeholder");
const bundleMetafilePath = resolve(root, "release/bundle-metafile.json");
if (!existsSync(bundleMetafilePath)) {
  findings.push("bundler metafile must describe dist/agentbox.js");
} else {
  const bundleMetafile = JSON.parse(readFileSync(bundleMetafilePath, "utf8"));
  if (!bundleMetafile.outputs || !Object.keys(bundleMetafile.outputs).some((path) => path.endsWith("dist/agentbox.js"))) {
    findings.push("bundler metafile must describe dist/agentbox.js");
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log(`release metadata is ready for @agtbox/cli ${packageJson.version}`);
