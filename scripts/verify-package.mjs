import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

function pack(root, destination) {
  const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: root });
  const result = JSON.parse(output)[0];
  return {
    filename: resolve(destination, result.filename),
    result,
    files: result.files.map(({ path }) => `package/${path}`).sort(),
  };
}

const root = resolve(argument("--root", process.cwd()));
const allowlist = resolve(argument("--allowlist", resolve(root, "release/package-files.json")));
const retainedDirectory = argument("--output-directory", undefined);
const sourceTree = argument("--source-tree", undefined);
const expected = JSON.parse(readFileSync(allowlist, "utf8")).sort();
const firstDirectory = retainedDirectory
  ? resolve(retainedDirectory)
  : mkdtempSync(resolve(tmpdir(), "agtbox-pack-a-"));
const secondDirectory = mkdtempSync(resolve(tmpdir(), "agtbox-pack-b-"));
const unpacked = mkdtempSync(resolve(tmpdir(), "agtbox-unpacked-"));
let verified = false;

try {
  if (retainedDirectory) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceTree ?? "")) {
      throw new Error("retained package requires the immutable source tree object ID");
    }
    mkdirSync(firstDirectory, { recursive: true });
    if (readdirSync(firstDirectory).length !== 0) {
      throw new Error("retained package output directory must be empty");
    }
  }
  const first = pack(root, firstDirectory);
  const second = pack(root, secondDirectory);
  const unlisted = first.files.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !first.files.includes(file));
  if (unlisted.length > 0 || missing.length > 0) {
    throw new Error([
      ...unlisted.map((file) => `npm package contains an unlisted file: ${file}`),
      ...missing.map((file) => `npm package is missing an allowlisted file: ${file}`),
    ].join("\n"));
  }

  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const sha256 = digest(first.filename);
  if (sha256 !== digest(second.filename)) {
    throw new Error("two no-script npm pack runs produced different tarball bytes");
  }

  if (!process.argv.includes("--skip-content-scan")) {
    run("tar", ["-xzf", first.filename, "-C", unpacked]);
    const scanner = fileURLToPath(new URL("./scan-unpacked-package.mjs", import.meta.url));
    run(process.execPath, [scanner, unpacked]);
  }

  if (retainedDirectory) {
    const manifest = {
      package: first.result.name,
      version: first.result.version,
      filename: first.result.filename,
      sha256,
      sourceTree,
      files: first.result.files.map(({ path, size }) => ({ path: `package/${path}`, size })),
    };
    writeFileSync(resolve(firstDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(resolve(firstDirectory, `${first.result.filename}.sha256`), `${sha256}  ${first.result.filename}\n`);
  }
  verified = true;
  console.log(`verified deterministic no-script npm package (${first.files.length} files, sha256 ${sha256})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!retainedDirectory || !verified) rmSync(firstDirectory, { recursive: true, force: true });
  rmSync(secondDirectory, { recursive: true, force: true });
  rmSync(unpacked, { recursive: true, force: true });
}
