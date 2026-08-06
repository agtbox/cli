import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifier = new URL("../scripts/verify-public-tree.mjs", import.meta.url);

function run(root, allowlist, filesystemFixture = true) {
  return spawnSync(process.execPath, [
    verifier.pathname,
    "--root", root,
    "--allowlist", allowlist,
    ...(filesystemFixture ? ["--filesystem-fixture"] : []),
  ], {
    encoding: "utf8",
  });
}

test("public-tree verification rejects a file outside the positive allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-tree-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "allowed.txt"), "public\n");
  writeFileSync(join(root, ".env"), `${["SEC", "RET"].join("")}=${["should", "not", "exist"].join("-")}\n`);
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["allowed.txt", "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not present in the public-file allowlist: \.env/);
});

test("public-tree verification rejects a real repository with an empty index", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-empty-index-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "public.txt"), "public\n");
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["public.txt", "release/public-files.json"]));
  execFileSync("git", ["init", "-q"], { cwd: root });

  const result = run(root, allowlist, false);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public Git index is empty/);
});

test("public-tree verification rejects allowlisted symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-symlink-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "target.txt"), "target\n");
  symlinkSync("target.txt", join(root, "public.txt"));
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["public.txt", "release/public-files.json", "target.txt"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic links are prohibited in the public tree: public\.txt/);
});

test("public-tree verification rejects tracked files inside ignored working directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-index-"));
  mkdirSync(join(root, "release"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "public.txt"), "public\n");
  writeFileSync(join(root, "node_modules", "forced.txt"), "must not be public\n");
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify([".gitignore", "public.txt", "release/public-files.json"]));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", ".gitignore", "public.txt", "release/public-files.json"], { cwd: root });
  execFileSync("git", ["add", "-f", "node_modules/forced.txt"], { cwd: root });

  const result = run(root, allowlist, false);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not present in the public-file allowlist: node_modules\/forced\.txt/);
});

test("public-tree verification scans allowlisted repository-only content", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-content-"));
  mkdirSync(join(root, "release"));
  const internalUrl = ["github.com", "private-owner", "service"].join("/");
  writeFileSync(join(root, "README.md"), `internal: ${internalUrl}\n`);
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["README.md", "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-public repository reference in README\.md/);
});

test("public-tree verification requires an exact public repository reference", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-reference-"));
  mkdirSync(join(root, "release"));
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["README.md", "release/public-files.json"]));
  const publicRepository = ["https://github.com", "agtbox/cli"].join("/");

  for (const reference of [
    `${publicRepository}-private`,
    `${publicRepository}.git.evil`,
    `${publicRepository}.git/path`,
  ]) {
    writeFileSync(join(root, "README.md"), `${reference}\n`);
    const result = run(root, allowlist);
    assert.notEqual(result.status, 0, reference);
    assert.match(result.stderr, /non-public repository reference in README\.md/);
  }

  for (const reference of [
    publicRepository,
    `${publicRepository}.git`,
    `${publicRepository}/issues/1`,
    `${publicRepository}?tab=readme`,
    `${publicRepository}#readme`,
  ]) {
    writeFileSync(join(root, "README.md"), `${reference}\n`);
    const result = run(root, allowlist);
    assert.equal(result.status, 0, `${reference}: ${result.stderr}`);
  }
});

test("public-tree verification rejects a prohibited private brand in a filename", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-name-"));
  mkdirSync(join(root, "release"));
  const prohibitedName = `${["qim", "atic"].join("")}.txt`;
  writeFileSync(join(root, prohibitedName), "content\n");
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify([prohibitedName, "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prohibited private brand or operator token in path/);
});
