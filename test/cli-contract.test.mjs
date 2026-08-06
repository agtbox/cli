import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { assertCiphertextSize, main, sha256Hex } = await import("../dist/index.js");

test("ciphertext output limit accepts the exact boundary and rejects one byte over", () => {
  assert.doesNotThrow(() => assertCiphertextSize(new Uint8Array(10 * 1024 * 1024)));
  assert.throws(() => assertCiphertextSize(new Uint8Array(10 * 1024 * 1024 + 1)), /exceeds/u);
});

test("encrypt and send reject oversize encrypted output without creating a ciphertext file", () => {
  const directory = mkdtempSync(join(tmpdir(), "agtbox-ciphertext-limit-"));
  const identityFile = join(directory, "identity.txt");
  const recipientFile = join(directory, "recipient.txt");
  const input = join(directory, "input.bin");
  const encryptedOutput = join(directory, "encrypt.age");
  const sentOutput = join(directory, "send.age");
  try {
    const generated = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "generate", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr);
    writeFileSync(recipientFile, `${JSON.parse(generated.stdout).publicKey}\n`, { mode: 0o600 });
    chmodSync(recipientFile, 0o600);
    writeFileSync(input, Buffer.alloc(10 * 1024 * 1024));
    const encrypt = spawnSync(process.execPath, [
      "dist/agentbox.js", "encrypt", "--input", input, "--recipient-file", recipientFile, "--output", encryptedOutput,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(encrypt.status, 1);
    assert.match(JSON.parse(encrypt.stderr).error.message, /Encrypted ciphertext exceeds/u);
    assert.equal(existsSync(encryptedOutput), false);

    const send = spawnSync(process.execPath, [
      "dist/agentbox.js", "send", "--endpoint", "https://agentbox.link", "--input", input, "--recipient-file", recipientFile,
      "--payer-key-file", identityFile, "--capabilities-file", join(directory, "capabilities.json"), "--ciphertext-file", sentOutput,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(send.status, 1);
    assert.match(JSON.parse(send.stderr).error.message, /Encrypted ciphertext exceeds/u);
    assert.equal(existsSync(sentOutput), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agentbox reports stable package identity as JSON", () => {
  const result = spawnSync(process.execPath, ["dist/agentbox.js", "--version", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { name: "@agtbox/cli", version: "0.1.1" });
  assert.equal(result.stderr, "");
});

test("secret input files with group or other access are rejected", () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "agtbox-secret-mode-"));
  const identityFile = join(directory, "identity.txt");
  try {
    writeFileSync(identityFile, "not-a-secret-key\n");
    chmodSync(identityFile, 0o644);
    const result = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "import", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).error.message, /protected/u);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("payment recovery files retain Windows-compatible permissions but reject broad POSIX permissions", async () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "agtbox-recovery-mode-"));
  const identityFile = join(directory, "identity.txt");
  const recipientFile = join(directory, "recipient.txt");
  const payerKeyFile = join(directory, "payer-key.txt");
  const ciphertextFile = join(directory, "ciphertext.age");
  const recoveryFile = `${ciphertextFile}.payment.json`;
  try {
    const generated = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "generate", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    writeFileSync(recipientFile, `${JSON.parse(generated.stdout).publicKey}\n`, { mode: 0o600 });
    chmodSync(recipientFile, 0o600);
    writeFileSync(payerKeyFile, `0x${"1".repeat(64)}\n`, { mode: 0o600 });
    chmodSync(payerKeyFile, 0o600);
    writeFileSync(ciphertextFile, "ciphertext", { mode: 0o600 });
    writeFileSync(recoveryFile, JSON.stringify({
      ciphertextSha256: await sha256Hex(readFileSync(ciphertextFile)), endpoint: "https://agentbox.link/",
      idempotencyKey: "recovery-permissions", paymentSignature: "saved-authorization",
    }), { mode: 0o644 });
    chmodSync(recoveryFile, 0o644);

    const result = spawnSync(process.execPath, [
      "dist/agentbox.js", "send", "--endpoint", "https://agentbox.link/", "--input", ciphertextFile,
      "--recipient-file", recipientFile, "--payer-key-file", payerKeyFile, "--capabilities-file", join(directory, "capabilities.json"),
      "--idempotency-key", "recovery-permissions", "--ciphertext-file", ciphertextFile,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).error.message, /protected regular file/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("identity generation writes a protected key and prints only its recipient", () => {
  const directory = mkdtempSync(join(tmpdir(), "agtbox-identity-"));
  const identityFile = join(directory, "identity.txt");
  try {
    const result = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "generate", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.publicKey, /^age1/u);
    assert.equal(output.identityFile, identityFile);
    assert.doesNotMatch(result.stdout, /AGE-SECRET-KEY/u);
    assert.match(readFileSync(identityFile, "utf8"), /^AGE-SECRET-KEY-1/u);
    assert.equal(statSync(identityFile).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("encryption accepts stdin and refuses to replace an existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "agtbox-stdin-"));
  const identityFile = join(directory, "identity.txt");
  const recipientFile = join(directory, "recipient.txt");
  const output = join(directory, "ciphertext.age");
  try {
    const generated = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "generate", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    const publicKey = JSON.parse(generated.stdout).publicKey;
    writeFileSync(recipientFile, `${publicKey}\n`, { mode: 0o600 });
    chmodSync(recipientFile, 0o600);
    const encrypted = spawnSync(process.execPath, [
      "dist/agentbox.js", "encrypt", "--input", "-", "--recipient-file", recipientFile, "--output", output,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8", input: Buffer.from([0, 255]) });
    assert.equal(encrypted.status, 0, encrypted.stderr);
    assert.equal(JSON.parse(encrypted.stdout).ciphertextSize > 2, true);

    const repeated = spawnSync(process.execPath, [
      "dist/agentbox.js", "encrypt", "--input", "-", "--recipient-file", recipientFile, "--output", output,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8", input: Buffer.from([1]) });
    assert.equal(repeated.status, 1);
    assert.match(JSON.parse(repeated.stderr).error.message, /must not already exist/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage failures are stable JSON on stderr with exit code 2", () => {
  const result = spawnSync(process.execPath, ["dist/agentbox.js", "unknown"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: { code: "usage", message: "Usage: identity generate|import, encrypt, decrypt, send, inspect, download, receive, or delete." },
  });
  assert.equal(result.stdout, "");
});

test("byte inputs reject symbolic links", () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync(join(tmpdir(), "agtbox-input-link-"));
  const identityFile = join(directory, "identity.txt");
  const recipientFile = join(directory, "recipient.txt");
  const input = join(directory, "input.bin");
  const link = join(directory, "input-link.bin");
  try {
    const generated = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "generate", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    writeFileSync(recipientFile, `${JSON.parse(generated.stdout).publicKey}\n`, { mode: 0o600 });
    chmodSync(recipientFile, 0o600);
    writeFileSync(input, "data");
    symlinkSync(input, link);
    const result = spawnSync(process.execPath, [
      "dist/agentbox.js", "encrypt", "--input", link, "--recipient-file", recipientFile, "--output", join(directory, "out.age"),
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).error.message, /symbolic link|ELOOP/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("send allowlists service fields before protected-file and stdout results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agtbox-send-output-"));
  const identityFile = join(directory, "identity.txt");
  const recipientFile = join(directory, "recipient.txt");
  const input = join(directory, "input.bin");
  const ciphertextFile = join(directory, "ciphertext.age");
  const payerKeyFile = join(directory, "payer-key.txt");
  const capabilitiesFile = join(directory, "capabilities.json");
  const endpoint = "https://agentbox.link/";
  const idempotencyKey = "output-allowlist";
  const previousFetch = globalThis.fetch;
  try {
    const generated = spawnSync(process.execPath, ["dist/agentbox.js", "identity", "generate", "--identity-file", identityFile], {
      cwd: new URL("..", import.meta.url), encoding: "utf8",
    });
    writeFileSync(recipientFile, `${JSON.parse(generated.stdout).publicKey}\n`, { mode: 0o600 });
    chmodSync(recipientFile, 0o600);
    writeFileSync(input, "payload");
    const encrypted = spawnSync(process.execPath, [
      "dist/agentbox.js", "encrypt", "--input", input, "--recipient-file", recipientFile, "--output", ciphertextFile,
    ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(encrypted.status, 0, encrypted.stderr);
    writeFileSync(payerKeyFile, `0x${"1".repeat(64)}\n`, { mode: 0o600 });
    chmodSync(payerKeyFile, 0o600);
    writeFileSync(`${ciphertextFile}.payment.json`, JSON.stringify({
      ciphertextSha256: await sha256Hex(readFileSync(ciphertextFile)),
      endpoint,
      idempotencyKey,
      paymentSignature: "saved-authorization",
    }), { mode: 0o600 });
    const box = {
      boxId: "box",
      createdAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-05T00:00:00.000Z",
      upload: { capability: "write", url: `${endpoint}v1/boxes/box` },
      download: { capability: "read", url: `${endpoint}v1/boxes/box` },
      delete: { capability: "delete", url: `${endpoint}v1/boxes/box` },
    };
    globalThis.fetch = async (request, init) => new Request(request, init).method === "POST"
      ? Response.json({ ...box, paymentSignature: "must-not-print", privateKey: "must-not-print" }, { status: 201 })
      : new Response(null, { status: 204 });

    const result = await main([
      "send", "--endpoint", endpoint, "--input", input, "--recipient-file", recipientFile,
      "--payer-key-file", payerKeyFile, "--capabilities-file", capabilitiesFile,
      "--idempotency-key", idempotencyKey, "--ciphertext-file", ciphertextFile,
    ]);
    assert.deepEqual(result, {
      boxId: box.boxId,
      capabilitiesFile,
      createdAt: box.createdAt,
      expiresAt: box.expiresAt,
      idempotencyKey,
    });
    assert.deepEqual(JSON.parse(readFileSync(capabilitiesFile, "utf8")), { ...box, idempotencyKey });
    assert.equal(existsSync(`${ciphertextFile}.payment.json`), false);

    writeFileSync(`${ciphertextFile}.payment.json`, JSON.stringify({
      ciphertextSha256: await sha256Hex(readFileSync(ciphertextFile)), endpoint, idempotencyKey, paymentSignature: "saved-authorization",
    }), { mode: 0o600 });
    globalThis.fetch = async () => new Response(null, { status: 402 });
    await assert.rejects(main([
      "send", "--endpoint", endpoint, "--input", input, "--recipient-file", recipientFile,
      "--payer-key-file", payerKeyFile, "--capabilities-file", join(directory, "ambiguous-capabilities.json"),
      "--idempotency-key", idempotencyKey, "--ciphertext-file", ciphertextFile,
    ]), /rejected the payment authorization/u);
    assert.equal(existsSync(`${ciphertextFile}.payment.json`), true);

    globalThis.fetch = async () => new Response(null, { headers: { "payment-response": "invalid" }, status: 402 });
    await assert.rejects(main([
      "send", "--endpoint", endpoint, "--input", input, "--recipient-file", recipientFile,
      "--payer-key-file", payerKeyFile, "--capabilities-file", join(directory, "definitive-capabilities.json"),
      "--idempotency-key", idempotencyKey, "--ciphertext-file", ciphertextFile,
    ]), /rejected the payment authorization/u);
    assert.equal(existsSync(`${ciphertextFile}.payment.json`), false);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
