import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifier = new URL("../scripts/verify-third-party-notices.mjs", import.meta.url);

test("third-party verification requires each declared component in the notice file", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-notices-"));
  mkdirSync(join(root, "third-party-licenses"));
  const manifest = join(root, "components.json");
  const notices = join(root, "notices.md");
  const metafile = join(root, "bundle-metafile.json");
  const licenseTextSha256 = createHash("sha256").update("license text").digest("hex");
  const licenseFile = `third-party-licenses/${licenseTextSha256}.txt`;
  writeFileSync(join(root, licenseFile), "license text\n");
  writeFileSync(manifest, JSON.stringify([{
    name: "example",
    version: "1.2.3",
    license: "MIT",
    licenseFile,
    licenseTextSha256,
    noticeSha256: createHash("sha256").update("exact notice").digest("hex"),
  }]));
  writeFileSync(notices, "# Notices\n");
  writeFileSync(metafile, JSON.stringify({ inputs: {}, outputs: {} }));

  const result = spawnSync(process.execPath, [verifier.pathname, "--manifest", manifest, "--notices", notices, "--bundle-metafile", metafile], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing notice heading for example@1\.2\.3 \(MIT\)/);
});

test("third-party verification rejects altered notice text", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-notice-hash-"));
  mkdirSync(join(root, "third-party-licenses"));
  const manifest = join(root, "components.json");
  const notices = join(root, "notices.md");
  const metafile = join(root, "bundle-metafile.json");
  const licenseTextSha256 = createHash("sha256").update("license text").digest("hex");
  const licenseFile = `third-party-licenses/${licenseTextSha256}.txt`;
  writeFileSync(join(root, licenseFile), "license text\n");
  writeFileSync(manifest, JSON.stringify([{
    name: "example",
    version: "1.2.3",
    license: "MIT",
    licenseFile,
    licenseTextSha256,
    noticeSha256: createHash("sha256").update("exact notice").digest("hex"),
  }]));
  writeFileSync(notices, "# Notices\n\n## example@1.2.3 (MIT)\n\naltered notice\n");
  writeFileSync(metafile, JSON.stringify({ inputs: {}, outputs: {} }));

  const result = spawnSync(process.execPath, [verifier.pathname, "--manifest", manifest, "--notices", notices, "--bundle-metafile", metafile], {
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /notice text hash does not match for example@1\.2\.3 \(MIT\)/);
});

test("third-party verification rejects an undeclared locked production dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-notice-graph-"));
  const manifest = join(root, "components.json");
  const notices = join(root, "notices.md");
  const lock = join(root, "package-lock.json");
  const metafile = join(root, "bundle-metafile.json");
  writeFileSync(manifest, "[]\n");
  writeFileSync(notices, "# Notices\n");
  writeFileSync(lock, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { example: "1.2.3" } },
      "node_modules/example": { version: "1.2.3" },
    },
  }));
  writeFileSync(metafile, JSON.stringify({ inputs: { "node_modules/example/index.js": {} }, outputs: {} }));

  const result = spawnSync(process.execPath, [
    verifier.pathname,
    "--manifest", manifest,
    "--notices", notices,
    "--lockfile", lock,
    "--bundle-metafile", metafile,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing third-party declaration for shipped component: example@1\.2\.3/);
});

test("third-party verification rejects a stale metafile that omits shipped output", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-stale-metafile-"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "agentbox.js"), "console.log('built');\n");
  const manifest = join(root, "components.json");
  const notices = join(root, "notices.md");
  const lock = join(root, "package-lock.json");
  const metafile = join(root, "bundle-metafile.json");
  writeFileSync(manifest, "[]\n");
  writeFileSync(notices, "# Notices\n");
  writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
  writeFileSync(metafile, JSON.stringify({ inputs: {}, outputs: {} }));

  const result = spawnSync(process.execPath, [
    verifier.pathname,
    "--manifest", manifest,
    "--notices", notices,
    "--lockfile", lock,
    "--bundle-metafile", metafile,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shipped dist file is absent from the generated bundler metafile: dist\/agentbox\.js/);
});

test("third-party verification requires the generated bundler metafile", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-missing-metafile-"));
  const manifest = join(root, "components.json");
  const notices = join(root, "notices.md");
  const lock = join(root, "package-lock.json");
  const metafile = join(root, "bundle-metafile.json");
  writeFileSync(manifest, "[]\n");
  writeFileSync(notices, "# Notices\n");
  writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));

  const result = spawnSync(process.execPath, [
    verifier.pathname,
    "--manifest", manifest,
    "--notices", notices,
    "--lockfile", lock,
    "--bundle-metafile", metafile,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated bundler metafile is missing/);
});

test("third-party verification rejects an invalid generated bundler metafile", () => {
  const root = mkdtempSync(join(tmpdir(), "agtbox-invalid-metafile-"));
  const manifest = join(root, "components.json");
  const notices = join(root, "notices.md");
  const lock = join(root, "package-lock.json");
  const metafile = join(root, "bundle-metafile.json");
  writeFileSync(manifest, "[]\n");
  writeFileSync(notices, "# Notices\n");
  writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
  writeFileSync(metafile, "not json\n");

  const result = spawnSync(process.execPath, [
    verifier.pathname,
    "--manifest", manifest,
    "--notices", notices,
    "--lockfile", lock,
    "--bundle-metafile", metafile,
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated bundler metafile is invalid JSON/);
});
