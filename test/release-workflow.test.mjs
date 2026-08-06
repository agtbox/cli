import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("release build verifies complete reachable author history", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const actorGuards = workflow.match(/^    if: github\.actor == 'agtbox-dev' && github\.triggering_actor == 'agtbox-dev'$/gmu) ?? [];
  assert.equal(actorGuards.length, 2);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /npm run verify:authors -- "\$GITHUB_SHA"/u);
  assert.ok(workflow.indexOf("verify:authors") < workflow.indexOf("release:artifact"));
  assert.match(workflow, /execFileSync\("npm",\["--version"\]/u);
  assert.doesNotMatch(workflow, /npm_config_user_agent/u);
  assert.match(workflow, /AGTBOX_RELEASE_TAG_SIGNING_ALLOWED_SIGNER/u);
  assert.match(workflow, /AGTBOX_RELEASE_REQUIRED_PUBLIC_ANCESTOR/u);
  assert.match(workflow, /git rev-parse "\$GITHUB_REF\^\{commit\}"/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$AGTBOX_RELEASE_REQUIRED_PUBLIC_ANCESTOR" "\$release_commit"/u);
  assert.match(workflow, /git cat-file -e "\$GITHUB_REF\^\{tag\}"/u);
  assert.match(workflow, /verify-tag "\$GITHUB_REF"/u);
});

test("pull-request verification installs the pinned supported Bun before testing", () => {
  const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  assert.match(workflow, /branches:\s+- main/u);
  assert.match(workflow, /- "release\/\*\*"/u);
  assert.match(workflow, /tags:\s+- "v\*"/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.match(workflow, /if: github\.actor == 'agtbox-dev' && github\.triggering_actor == 'agtbox-dev'/u);
  const setup = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
  assert.match(workflow, new RegExp(setup, "u"));
  assert.match(workflow, /bun-version: "1\.3\.0"/u);
  assert.ok(workflow.indexOf(setup) < workflow.indexOf("npm ci --ignore-scripts"));
});
