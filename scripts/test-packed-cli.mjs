import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball) {
  console.error("usage: node scripts/test-packed-cli.mjs <package.tgz> [--require-bun]");
  process.exit(2);
}

const expected = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const root = mkdtempSync(resolve(tmpdir(), "agtbox-clean-install-"));
const cleanEnvironment = {
  PATH: process.env.PATH,
  BUN_INSTALL_CACHE_DIR: resolve(root, "bun-cache"),
  npm_config_audit: "false",
  npm_config_cache: resolve(root, "npm-cache"),
  npm_config_fund: "false",
  npm_config_ignore_scripts: "true",
  npm_config_update_notifier: "false",
};

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: cleanEnvironment, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function assertVersion(output, runtime) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    console.error(`${runtime} executable did not return JSON for --version --json`);
    process.exit(1);
  }
  if (value.name !== "@agtbox/cli" || value.version !== expected.version) {
    console.error(`${runtime} executable returned the wrong package identity or version`);
    process.exit(1);
  }
}

try {
  writeFileSync(resolve(root, "package.json"), "{\"private\":true}\n");
  run("npm", ["install", "--ignore-scripts", "--install-strategy=linked", tarball]);
  const executable = process.platform === "win32" ? "agentbox.cmd" : "agentbox";
  assertVersion(run(resolve(root, "node_modules", ".bin", executable), ["--version", "--json"]), "Node/npm");
  const identityFile = resolve(root, "identity.txt");
  const recipientFile = resolve(root, "recipient.txt");
  const plaintextFile = resolve(root, "plaintext.bin");
  const ciphertextFile = resolve(root, "ciphertext.age");
  const decryptedFile = resolve(root, "decrypted.bin");
  const identity = JSON.parse(run(resolve(root, "node_modules", ".bin", executable), [
    "identity", "generate", "--identity-file", identityFile,
  ]));
  writeFileSync(recipientFile, `${identity.publicKey}\n`, { mode: 0o600 });
  chmodSync(recipientFile, 0o600);
  writeFileSync(plaintextFile, Buffer.from([0, 1, 2, 253, 254, 255]));
  const encrypted = JSON.parse(run(resolve(root, "node_modules", ".bin", executable), [
    "encrypt", "--input", plaintextFile, "--recipient-file", recipientFile, "--output", ciphertextFile,
  ]));
  run(resolve(root, "node_modules", ".bin", executable), [
    "decrypt", "--input", ciphertextFile, "--sha256", encrypted.ciphertextSha256,
    "--identity-file", identityFile, "--output", decryptedFile,
  ]);
  if (!readFileSync(decryptedFile).equals(readFileSync(plaintextFile))) {
    console.error("packed CLI encryption round trip changed the payload");
    process.exit(1);
  }
  writeFileSync(resolve(root, "api.mjs"), [
    "import { packageIdentity, createAndUpload, downloadAndVerify } from '@agtbox/cli';",
    `if (packageIdentity.name !== '@agtbox/cli' || typeof createAndUpload !== 'function' || typeof downloadAndVerify !== 'function') process.exit(1);`,
  ].join("\n"));
  run(process.execPath, [resolve(root, "api.mjs")]);
  writeFileSync(resolve(root, "consumer.ts"), [
    "import { type BoxResponse, packageIdentity, sha256Hex } from '@agtbox/cli';",
    "const identity: '@agtbox/cli' = packageIdentity.name;",
    "const box: BoxResponse | undefined = undefined;",
    "void identity; void box; void sha256Hex(new Uint8Array());",
  ].join("\n"));
  run(resolve(process.cwd(), "node_modules", ".bin", "tsc"), [
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "--noEmit", "--skipLibCheck", resolve(root, "consumer.ts"),
  ]);

  const bun = spawnSync("bun", ["--version"], { env: cleanEnvironment, encoding: "utf8" });
  if (bun.status === 0) {
    const bunRoot = resolve(root, "bun");
    mkdirSync(bunRoot);
    writeFileSync(resolve(bunRoot, "package.json"), "{\"private\":true}\n");
    run("bun", ["add", "--ignore-scripts", "--no-save", tarball], bunRoot);
    const bunPath = `${resolve(bunRoot, "node_modules", ".bin")}${delimiter}${cleanEnvironment.PATH}`;
    const result = spawnSync("agentbox", ["--version", "--json"], {
      cwd: bunRoot,
      env: { ...cleanEnvironment, PATH: bunPath },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      process.exit(result.status ?? 1);
    }
    assertVersion(result.stdout, "Bun");
  } else if (process.argv.includes("--require-bun")) {
    console.error("Bun is required for the release artifact test but is unavailable");
    process.exit(1);
  }

  console.log("packed CLI installs inertly and passes executable, crypto, and API smoke tests under supported package managers");
} finally {
  rmSync(root, { recursive: true, force: true });
}
