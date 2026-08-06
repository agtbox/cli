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

test("public-tree verification rejects allowlisted environment directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-env-directory-"));
  mkdirSync(join(root, ".env"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, ".env", "secret"), "clean-looking\n");
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify([".env/secret", "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environment-secret path in \.env\/secret/);
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

test("public-tree verification rejects non-public GitHub repository transport forms", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-github-reference-"));
  mkdirSync(join(root, "release"));
  const invalidReferences = [
    ["https://", "github.com", "/agtbox/", "cli-private"].join(""),
    ["https://", "github.com", "/agtbox/", "cli.git.evil"].join(""),
    ["https://", "github.com", "/agtbox/", "cli.git/path"].join(""),
    ["git@", "github.com", ":agtbox/", "cli-private.git"].join(""),
    ["ssh://git@", "github.com", "/agtbox/", "cli-private.git"].join(""),
    ["git://", "github.com", "/agtbox/", "cli-private.git"].join(""),
    ["https://", "github.com", ":443/agtbox/cli"].join(""),
  ];
  writeFileSync(join(root, "README.md"), invalidReferences.join("\n"));
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["README.md", "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-public repository reference in README\.md/);
});

test("public-tree verification accepts exact public repository URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-github-reference-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "README.md"), [
    "https://github.com/agtbox/cli",
    "https://github.com/agtbox/cli/issues?state=open#new",
    "git+https://github.com/agtbox/cli.git#v0.1.0",
    "ssh://git@github.com/agtbox/cli.git",
    "git://github.com/agtbox/cli.git",
    "git@github.com:agtbox/cli.git",
    "HTTPS://GITHUB.COM/AGTBOX/CLI",
  ].join("\n"));
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["README.md", "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.equal(result.status, 0, result.stderr);
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

test("public-tree verification rejects agentic documentation even when allowlisted", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-public-agent-doc-"));
  mkdirSync(join(root, "release"));
  writeFileSync(join(root, "AGENTS.md"), "private instructions\n");
  const allowlist = join(root, "release", "public-files.json");
  writeFileSync(allowlist, JSON.stringify(["AGENTS.md", "release/public-files.json"]));

  const result = run(root, allowlist);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agentic documentation is prohibited in the public tree: AGENTS\.md/);
});
