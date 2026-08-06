import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const publisher = new URL("../scripts/publish-artifact.mjs", import.meta.url);

test("publishing refuses traditional npm credentials", () => {
  const result = spawnSync(process.execPath, [publisher.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_TOKEN: "must-not-be-used",
      GITHUB_ACTIONS: "true",
      NPM_TRUSTED_PUBLISHING_READY: "true",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /traditional npm publish credentials are prohibited/);
});
