import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const rootScripts = resolve(root, "scripts");
const artifacts = resolve(root, "release-artifacts");
let snapshot;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout;
}

try {
  run(process.execPath, [resolve(rootScripts, "verify-public-tree.mjs")]);
  const sourceTree = run("git", ["write-tree"]).trim();
  snapshot = mkdtempSync(resolve(tmpdir(), "agtbox-release-tree-"));
  const archive = spawnSync("git", ["archive", "--format=tar", sourceTree], {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(archive.stderr.toString("utf8").trim());
  const extracted = spawnSync("tar", ["-xf", "-", "-C", snapshot], {
    input: archive.stdout,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error(extracted.stderr.trim());

  const scripts = resolve(snapshot, "scripts");
  run(process.execPath, [resolve(scripts, "verify-public-tree.mjs"), "--root", snapshot, "--filesystem-fixture"], { cwd: snapshot });
  const packageJson = JSON.parse(readFileSync(resolve(snapshot, "package.json"), "utf8"));
  if (typeof packageJson.scripts?.["build:release"] === "string") {
    run("npm", ["ci", "--ignore-scripts"], { cwd: snapshot });
    run("npm", ["test"], { cwd: snapshot, env: { ...process.env, AGTBOX_ARTIFACT_BUILD: "true" } });
    run("npm", ["run", "typecheck", "--if-present"], { cwd: snapshot });
    run("npm", ["run", "lint", "--if-present"], { cwd: snapshot });
    rmSync(resolve(snapshot, "dist"), { recursive: true, force: true });
    rmSync(resolve(snapshot, "release", "bundle-metafile.json"), { force: true });
    run("npm", ["run", "build:release"], { cwd: snapshot });
  }

  run(process.execPath, [resolve(scripts, "verify-release-readiness.mjs"), snapshot], { cwd: snapshot });
  run(process.execPath, [resolve(scripts, "verify-third-party-notices.mjs")], { cwd: snapshot });
  rmSync(artifacts, { recursive: true, force: true });
  run(process.execPath, [
    resolve(scripts, "verify-package.mjs"),
    "--root", snapshot,
    "--output-directory", artifacts,
    "--source-tree", sourceTree,
  ], { cwd: snapshot });

  const manifest = JSON.parse(readFileSync(resolve(artifacts, "manifest.json"), "utf8"));
  const tarball = resolve(artifacts, manifest.filename);
  run(process.execPath, [resolve(scripts, "test-packed-cli.mjs"), tarball, "--require-bun"], { cwd: snapshot });
  console.log(`release artifact ready: ${manifest.filename} (${manifest.sha256}, tree ${sourceTree})`);
} catch (error) {
  rmSync(artifacts, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
