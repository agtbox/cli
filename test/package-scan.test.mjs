import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scanner = new URL("../scripts/scan-unpacked-package.mjs", import.meta.url);

function scan(files) {
  const root = mkdtempSync(join(tmpdir(), "agtbox-package-scan-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return spawnSync(process.execPath, [scanner.pathname, root], { encoding: "utf8" });
}

test("unpacked-package scan rejects secret-bearing and private-workspace content", () => {
  const workspace = ["", "home", "example", "private-workspace"].join("/");
  const privateRepository = ["github.com", "private-owner", "service"].join("/");
  const credential = ["cfat", "example"].join("_");
  const result = scan({
    "package/index.js": `const source = '${workspace}';\nconst repo = '${privateRepository}';\nconst value = '${credential}';\n`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private workspace path/);
  assert.match(result.stderr, /non-public repository reference/);
  assert.match(result.stderr, /Cloudflare credential prefix/);
});

test("unpacked-package scan rejects source maps and private implementation paths", () => {
  const result = scan({
    "package/dist/index.js.map": JSON.stringify({ sourcesContent: ["source"] }),
    "package/infra/Pulumi.yaml": "name: leaked\n",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source map/);
  assert.match(result.stderr, /private implementation path/);
});

test("unpacked-package scan accepts an allowlisted public artifact", () => {
  const result = scan({
    "package/dist/agentbox.js": "#!/usr/bin/env node\nconsole.log('agentbox');\n",
    "package/LICENSE": "license terms\n",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("unpacked-package scan requires an exact public repository reference", () => {
  const publicRepository = ["https://github.com", "agtbox/cli"].join("/");

  for (const reference of [
    `${publicRepository}-private`,
    `${publicRepository}.git.evil`,
    `${publicRepository}.git/path`,
  ]) {
    const result = scan({ "package/README.md": `${reference}\n` });
    assert.notEqual(result.status, 0, reference);
    assert.match(result.stderr, /non-public repository reference/);
  }

  for (const reference of [
    publicRepository,
    `${publicRepository}.git`,
    `${publicRepository}/issues/1`,
    `${publicRepository}?tab=readme`,
    `${publicRepository}#readme`,
  ]) {
    const result = scan({ "package/README.md": `${reference}\n` });
    assert.equal(result.status, 0, `${reference}: ${result.stderr}`);
  }
});

test("unpacked-package scan does not skip secret markers inside binary files", () => {
  const credential = [["cfut", "embeddedcredential"].join("_")];
  const result = scan({
    "package/dist/asset.bin": Buffer.from([0, ...Buffer.from(credential[0]), 0]),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cloudflare credential prefix/);
});

test("unpacked-package scan rejects generic assigned credentials", () => {
  const assignment = `${["api", "Key"].join("")} = '${"abcdefghijklmnopqrstuvwxyz123456"}'`;
  const result = scan({
    "package/dist/config.js": `const ${assignment};\n`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /assigned credential-shaped value/);
});

test("unpacked-package scan rejects a prohibited private brand in a filename", () => {
  const prohibitedName = `${["qim", "atic"].join("")}.txt`;
  const result = scan({ [`package/${prohibitedName}`]: "content\n" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prohibited private brand or operator token in path/);
});
