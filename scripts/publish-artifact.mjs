import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.GITHUB_ACTIONS !== "true") fail("publishing is restricted to GitHub Actions");
if (process.env.NPM_TRUSTED_PUBLISHING_READY !== "true") fail("npm trusted publishing has not been explicitly enabled");
const oidcAvailable = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
if (!oidcAvailable) {
  if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) fail("traditional npm publish credentials are prohibited");
  fail("GitHub OIDC identity is unavailable");
}
if (process.env.GITHUB_REPOSITORY !== "agtbox/cli") fail("unexpected GitHub repository identity");

const directory = resolve(process.argv[2] ?? "release-artifacts");
const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
const tarballs = readdirSync(directory).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== 1 || tarballs[0] !== manifest.filename) fail("release directory must contain exactly the manifested tarball");
if (process.env.GITHUB_REF !== `refs/tags/v${manifest.version}`) fail("release ref must exactly match the package version tag");
const sourceTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" });
if (sourceTree.status !== 0 || sourceTree.stdout.trim() !== manifest.sourceTree) fail("release artifact source tree does not match the checked-out tag");

const tarball = resolve(directory, manifest.filename);
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (digest !== manifest.sha256) fail("release tarball SHA-256 does not match its manifest");

const distTag = process.env.NPM_DIST_TAG ?? "latest";
if (!new Set(["latest", "next"]).has(distTag)) fail("unsupported npm distribution tag");

const result = spawnSync("npm", ["publish", tarball, "--access", "public", "--provenance", "--tag", distTag], {
  encoding: "utf8",
  env: { ...process.env, NODE_AUTH_TOKEN: undefined, NPM_TOKEN: undefined },
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
