import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifier = new URL("../scripts/verify-commit-authors.mjs", import.meta.url);

function repository(name, email) {
  const root = mkdtempSync(join(tmpdir(), "agtbox-author-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", name], { cwd: root });
  execFileSync("git", ["config", "user.email", email], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "test: fixture"], { cwd: root });
  return root;
}

function verify(root, revision) {
  return spawnSync(process.execPath, [verifier.pathname, root, ...(revision ? [revision] : [])], { encoding: "utf8" });
}

test("commit-author verification accepts the required identity", () => {
  const result = verify(repository("agtbox", "dev@agtbox.dev"));

  assert.equal(result.status, 0, result.stderr);
});

test("commit-author verification rejects any other identity", () => {
  const result = verify(repository("Another Author", "another@example.test"));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid commit author/);
});

test("commit-author verification rejects a different committer identity", () => {
  const root = repository("Personal Committer", "personal@example.test");
  execFileSync("git", ["commit", "--amend", "--allow-empty", "--no-edit", "--author", "agtbox <dev@agtbox.dev>"], { cwd: root });

  const result = verify(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid commit author or committer/);
});

test("commit-author verification rejects non-linear public history", () => {
  const root = repository("agtbox", "dev@agtbox.dev");
  const main = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "-b", "fixture-side"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "test: side"], { cwd: root });
  execFileSync("git", ["checkout", "-q", main], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "test: main"], { cwd: root });
  execFileSync("git", ["merge", "--no-ff", "fixture-side", "-m", "test: merge"], { cwd: root });

  const result = verify(root);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-linear public history/);
});

test("commit-author verification excludes a synthetic merge commit when given the real head", () => {
  const root = repository("agtbox", "dev@agtbox.dev");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["config", "user.name", "Synthetic GitHub Author"], { cwd: root });
  execFileSync("git", ["config", "user.email", "synthetic@example.test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "test: synthetic merge"], { cwd: root });

  const result = verify(root, head);

  assert.equal(result.status, 0, result.stderr);
});
