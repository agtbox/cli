import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifier = new URL("../scripts/verify-release-readiness.mjs", import.meta.url);

test("the built CLI satisfies release metadata and executable policy", () => {
  const result = spawnSync(process.execPath, [verifier.pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release metadata is ready for @agtbox\/cli 0\.1\.1/);
});

test("release readiness rejects modified PolyForm Shield terms", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-license-"));
  mkdirSync(join(root, "dist"));
  const executable = join(root, "dist", "agentbox.js");
  writeFileSync(executable, "#!/usr/bin/env node\n");
  chmodSync(executable, 0o755);
  writeFileSync(join(root, "NOTICE"), "Required Notice: Copyright 2026 Real Owner\n");
  writeFileSync(join(root, "LICENSE"), "modified terms\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@agtbox/cli",
    version: "1.0.0",
    private: false,
    license: "PolyForm-Shield-1.0.0",
    bin: { agentbox: "dist/agentbox.js" },
    repository: { url: "git+https://github.com/agtbox/cli.git" },
    publishConfig: { access: "public" },
    engines: { node: ">=22", bun: ">=1.3" },
  }));

  const result = spawnSync(process.execPath, [verifier.pathname, root], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LICENSE must be the exact unmodified PolyForm Shield 1\.0\.0 text/);
});

for (const hook of ["prepublish", "prepublishOnly", "publish", "postpublish", "dependencies", "preversion", "version", "postversion"]) {
  test(`release readiness rejects the ${hook} lifecycle hook`, () => {
    const root = mkdtempSync(join(tmpdir(), "agtbox-lifecycle-"));
    mkdirSync(join(root, "dist"));
    const executable = join(root, "dist", "agentbox.js");
    writeFileSync(executable, "#!/usr/bin/env node\n");
    chmodSync(executable, 0o755);
    writeFileSync(join(root, "NOTICE"), "Required Notice: Copyright 2026 Real Owner\n");
    writeFileSync(join(root, "LICENSE"), readFileSync(new URL("../LICENSE", import.meta.url)));
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "@agtbox/cli",
      version: "1.0.0",
      private: false,
      license: "PolyForm-Shield-1.0.0",
      bin: { agentbox: "dist/agentbox.js" },
      repository: { url: "git+https://github.com/agtbox/cli.git" },
      publishConfig: { access: "public" },
      engines: { node: ">=22", bun: ">=1.3" },
      scripts: { [hook]: "must-not-run" },
    }));

    const result = spawnSync(process.execPath, [verifier.pathname, root], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`package lifecycle script is prohibited: ${hook}`));
  });
}
