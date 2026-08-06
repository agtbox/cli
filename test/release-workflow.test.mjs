import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("release build verifies complete reachable author history", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /if: github\.actor == 'agtbox-dev'/u);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /npm run verify:authors -- "\$GITHUB_SHA"/u);
  assert.ok(workflow.indexOf("verify:authors") < workflow.indexOf("release:artifact"));
});

test("pull-request verification installs the pinned supported Bun before testing", () => {
  const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  const setup = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
  assert.match(workflow, new RegExp(setup, "u"));
  assert.match(workflow, /bun-version: "1\.3\.0"/u);
  assert.ok(workflow.indexOf(setup) < workflow.indexOf("npm ci --ignore-scripts"));
});
