import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifier = new URL("../scripts/verify-package.mjs", import.meta.url);

test("package verification rejects npm pack output beyond the committed allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-pack-manifest-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    files: ["index.js", "unexpected.txt"],
  }));
  writeFileSync(join(root, "index.js"), "export {};\n");
  writeFileSync(join(root, "unexpected.txt"), "must be rejected\n");
  const allowlist = join(root, "release", "package-files.json");
  writeFileSync(allowlist, JSON.stringify(["package/index.js", "package/package.json"]));

  const result = spawnSync(process.execPath, [
    verifier.pathname,
    "--root",
    root,
    "--allowlist",
    allowlist,
    "--skip-content-scan",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm package contains an unlisted file: package\/unexpected\.txt/);
});

test("package verification retains the exact scanned deterministic artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-retained-pack-"));
  const output = join(root, "release-artifacts");
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    files: ["index.js"],
  }));
  writeFileSync(join(root, "index.js"), "export {};\n");
  const allowlist = join(root, "release", "package-files.json");
  writeFileSync(allowlist, JSON.stringify(["package/index.js", "package/package.json"]));

  const result = spawnSync(process.execPath, [
    verifier.pathname,
    "--root",
    root,
    "--allowlist",
    allowlist,
    "--output-directory",
    output,
    "--source-tree",
    "1111111111111111111111111111111111111111",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  const tarball = readFileSync(join(output, manifest.filename));
  assert.equal(createHash("sha256").update(tarball).digest("hex"), manifest.sha256);
  assert.equal(manifest.sourceTree, "1111111111111111111111111111111111111111");
  assert.deepEqual(manifest.files.map(({ path }) => path), ["package/index.js", "package/package.json"]);
});
