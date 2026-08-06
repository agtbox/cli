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

test("OIDC takes precedence over runner-provided npm credential variables", () => {
  const result = spawnSync(process.execPath, [publisher.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: "runner-provided-value",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/request",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      GITHUB_ACTIONS: "true",
      NPM_TRUSTED_PUBLISHING_READY: "true",
      GITHUB_REPOSITORY: "agtbox/cli",
    },
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /traditional npm publish credentials are prohibited/);
  assert.match(result.stderr, /ENOENT: no such file or directory/);
});
