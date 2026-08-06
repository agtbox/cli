import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const builder = new URL("../scripts/build-release-artifact.mjs", import.meta.url);
const artifacts = resolve(root, "release-artifacts");

test("artifact construction retains an exact verified tarball", { skip: process.env.AGTBOX_ARTIFACT_BUILD === "true" }, () => {
  rmSync(artifacts, { recursive: true, force: true });

  const result = spawnSync(process.execPath, [builder.pathname], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(artifacts), true);
  assert.match(result.stdout, /release artifact ready: agtbox-cli-0\.1\.2\.tgz/);
});
