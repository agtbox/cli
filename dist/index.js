// src/cli.ts
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";

// src/contracts.ts
var MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024;
var MAX_CREATE_RESPONSE_BYTES = 16 * 1024;
var MAX_CAPACITY_RECLAIM_RETRIES = 83;
var BASE_MAINNET_NETWORK = "eip155:8453";
var BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
var CREATE_PRICE_USDC_ATOMIC = "10000";
var EXPECTED_PAYMENT_RECIPIENT = "0xb5363EDDE479640886cf708BC596F2aED09806A8";

// src/crypto.ts
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
async function generateRecipientIdentity() {
  const identity = await generateIdentity();
  return { identity, publicKey: await identityToRecipient(identity) };
}
async function recipientForIdentity(identity) {
  return identityToRecipient(identity);
}
async function encryptForRecipient(plaintext, publicKey) {
  const encrypter = new Encrypter();
  encrypter.addRecipient(publicKey);
  return encrypter.encrypt(plaintext);
}
async function decryptCiphertext(ciphertext, identity) {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(ciphertext);
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// src/handoff.ts
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

// src/request-commitment.ts
var REQUEST_COMMITMENT_HEADER = "x-agentbox-request-commitment";
function canonicalCreateRequest(input) {
  return JSON.stringify({ ciphertextSha256: input.ciphertextSha256, ciphertextSize: input.ciphertextSize });
}
function createRequestCommitment(options) {
  return JSON.stringify({
    body: { ciphertextSha256: options.input.ciphertextSha256, ciphertextSize: options.input.ciphertextSize },
    idempotencyKey: options.idempotencyKey,
    method: "POST",
    resource: new URL("/v1/boxes", options.origin).toString(),
    version: "agentbox-request-v1"
  });
}

// src/handoff.ts
var PaymentRejectedError = class extends Error {
  constructor(message, definitive = false) {
    super(message);
    this.definitive = definitive;
    this.name = "PaymentRejectedError";
  }
};
function endpointUrl(endpoint, path) {
  const base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  if (base.protocol !== "https:") throw new Error("agentbox endpoint must use HTTPS.");
  return new URL(path, base).toString();
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isHandoffUrl(value, expectedOrigin, boxId) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === expectedOrigin && url.pathname === `/v1/boxes/${encodeURIComponent(boxId)}` && !url.search && !url.hash;
  } catch {
    return false;
  }
}
function validateResponse(value, expectedOrigin) {
  if (!value || typeof value !== "object") throw new Error("agentbox returned an invalid create response.");
  const box = value;
  if (!isNonEmptyString(box.boxId) || !isNonEmptyString(box.createdAt) || !isNonEmptyString(box.expiresAt) || !isNonEmptyString(box.upload?.capability) || !isNonEmptyString(box.upload?.url) || !isNonEmptyString(box.download?.capability) || !isNonEmptyString(box.download?.url) || !isNonEmptyString(box.delete?.capability) || !isNonEmptyString(box.delete?.url)) {
    throw new Error("agentbox returned an incomplete create response.");
  }
  if (!isHandoffUrl(box.upload.url, expectedOrigin, box.boxId) || !isHandoffUrl(box.download.url, expectedOrigin, box.boxId) || !isHandoffUrl(box.delete.url, expectedOrigin, box.boxId)) {
    throw new Error("agentbox returned unsafe handoff URLs.");
  }
  return {
    boxId: box.boxId,
    createdAt: box.createdAt,
    delete: { capability: box.delete.capability, url: box.delete.url },
    download: { capability: box.download.capability, url: box.download.url },
    expiresAt: box.expiresAt,
    upload: { capability: box.upload.capability, url: box.upload.url }
  };
}
function capabilityUrl(options) {
  const expectedOrigin = new URL(endpointUrl(options.endpoint, "/v1/boxes")).origin;
  if (!isHandoffUrl(options.url, expectedOrigin, options.boxId)) {
    throw new Error("agentbox capability URL does not match the trusted box.");
  }
  return new URL(options.url).toString();
}
async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CREATE_RESPONSE_BYTES) {
    throw new Error("agentbox create response exceeds the 16 KiB limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("agentbox returned an invalid create response.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > MAX_CREATE_RESPONSE_BYTES - size) {
        throw new Error("agentbox create response exceeds the 16 KiB limit.");
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("agentbox returned an invalid create response.");
  }
}
async function isCapacityReclaiming(response) {
  try {
    const body = await readBoundedJson(response);
    return body.error?.code === "capacity_reclaiming";
  } catch {
    return false;
  }
}
function paymentRetryFetch(fetch, paymentSignature) {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("payment-signature", paymentSignature);
    return fetch(input, { ...init, headers });
  };
}
function exactArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return Uint8Array.from(bytes).buffer;
}
function recordingPaymentFetch(fetch, callback) {
  return async (input, init) => {
    const request = new Request(input, init);
    const signature = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
    if (signature) await callback?.(signature);
    return fetch(input, init);
  };
}
async function createAndUpload(options) {
  if (!/^[1-9][0-9]*$/u.test(options.maxPriceAtomic) || BigInt(options.maxPriceAtomic) < BigInt(CREATE_PRICE_USDC_ATOMIC)) {
    throw new Error(`Configured maximum must cover ${CREATE_PRICE_USDC_ATOMIC} atomic USDC.`);
  }
  if (options.ciphertext.byteLength < 1 || options.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Ciphertext size is outside the allowed limit.");
  }
  const fetch = options.fetch ?? globalThis.fetch;
  const createUrl = endpointUrl(options.endpoint, "/v1/boxes");
  const account = privateKeyToAccount(options.payerPrivateKey);
  const input = { ciphertextSha256: await sha256Hex(options.ciphertext), ciphertextSize: options.ciphertext.byteLength };
  const requestCommitment = await account.signMessage({
    message: createRequestCommitment({ idempotencyKey: options.idempotencyKey, input, origin: new URL(createUrl).origin })
  });
  let paymentSignature = options.paymentSignature;
  const paymentFetch = paymentSignature ? paymentRetryFetch(fetch, paymentSignature) : wrapFetchWithPaymentFromConfig(recordingPaymentFetch(fetch, async (signature) => {
    paymentSignature = signature;
    await options.onPaymentSignature?.(signature);
  }), {
    paymentRequirementsSelector: (_version, requirements) => {
      const selected = requirements.find((requirement) => requirement.scheme === "exact" && requirement.network === BASE_MAINNET_NETWORK && requirement.asset.toLowerCase() === BASE_MAINNET_USDC.toLowerCase());
      if (!selected || selected.payTo.toLowerCase() !== EXPECTED_PAYMENT_RECIPIENT.toLowerCase()) {
        throw new Error("agentbox payment challenge is incompatible.");
      }
      if (BigInt(selected.amount) > BigInt(options.maxPriceAtomic)) {
        throw new Error("agentbox payment exceeds the configured maximum.");
      }
      return selected;
    },
    schemes: [{ client: new ExactEvmScheme(account), network: BASE_MAINNET_NETWORK }]
  });
  let create;
  for (let attempt = 0; attempt <= MAX_CAPACITY_RECLAIM_RETRIES; attempt += 1) {
    create = await (paymentSignature ? paymentRetryFetch(fetch, paymentSignature) : paymentFetch)(createUrl, {
      body: canonicalCreateRequest(input),
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey,
        [REQUEST_COMMITMENT_HEADER]: requestCommitment
      },
      method: "POST"
    });
    if (create.status !== 503 || !await isCapacityReclaiming(create) || attempt === MAX_CAPACITY_RECLAIM_RETRIES) break;
  }
  if (!create) throw new Error("agentbox create did not return a response.");
  if (create.status === 402) {
    throw new PaymentRejectedError("agentbox rejected the payment authorization.", create.headers.has("payment-response"));
  }
  if (create.status !== 201) throw new Error(`agentbox create failed with HTTP ${create.status}.`);
  const box = validateResponse(await readBoundedJson(create), new URL(createUrl).origin);
  const upload = await fetch(capabilityUrl({
    boxId: box.boxId,
    capability: box.upload.capability,
    endpoint: options.endpoint,
    url: box.upload.url
  }), {
    body: exactArrayBuffer(options.ciphertext),
    headers: {
      authorization: `Bearer ${box.upload.capability}`,
      "content-length": String(options.ciphertext.byteLength),
      "content-type": "application/octet-stream"
    },
    method: "PUT"
  });
  if (upload.status === 409) {
    const existing = await inspectBox({
      boxId: box.boxId,
      capability: box.download.capability,
      endpoint: options.endpoint,
      fetch,
      url: box.download.url
    });
    if (existing.ciphertextSize === options.ciphertext.byteLength && existing.ciphertextSha256 === input.ciphertextSha256) return box;
  }
  if (upload.status !== 204) throw new Error(`agentbox upload failed with HTTP ${upload.status}.`);
  return box;
}
function authorizedHeaders(capability) {
  return { authorization: `Bearer ${capability}` };
}
async function inspectBox(options) {
  const response = await (options.fetch ?? globalThis.fetch)(capabilityUrl(options), {
    headers: authorizedHeaders(options.capability),
    method: "HEAD"
  });
  if (response.status !== 200) throw new Error(`agentbox inspect failed with HTTP ${response.status}.`);
  const ciphertextSize = Number(response.headers.get("content-length"));
  const ciphertextSha256 = response.headers.get("x-agentbox-sha256");
  const createdAt = response.headers.get("x-agentbox-created-at");
  const expiresAt = response.headers.get("x-agentbox-expires-at");
  if (!Number.isSafeInteger(ciphertextSize) || ciphertextSize < 1 || ciphertextSize > MAX_CIPHERTEXT_BYTES || !/^[a-f0-9]{64}$/u.test(ciphertextSha256 ?? "") || !createdAt || !expiresAt) {
    throw new Error("agentbox returned incomplete ciphertext metadata.");
  }
  return { ciphertextSha256, ciphertextSize, createdAt, expiresAt };
}
async function readCiphertext(response, expectedSize) {
  const maximumSize = expectedSize ?? MAX_CIPHERTEXT_BYTES;
  if (!Number.isSafeInteger(maximumSize) || maximumSize < 1 || maximumSize > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Expected ciphertext size is outside the allowed limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("agentbox download response has no ciphertext body.");
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maximumSize - received) {
        throw new Error(`Downloaded ciphertext exceeds the ${expectedSize === void 0 ? "10 MiB limit" : "expected size"}.`);
      }
      chunks.push(next.value);
      received += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedSize !== void 0 && received !== expectedSize) {
    throw new Error("Downloaded ciphertext does not match the expected size.");
  }
  const ciphertext = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    ciphertext.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ciphertext;
}
async function downloadAndVerify(options) {
  const response = await (options.fetch ?? globalThis.fetch)(capabilityUrl(options), {
    headers: authorizedHeaders(options.capability),
    method: "GET"
  });
  if (response.status !== 200) throw new Error(`agentbox download failed with HTTP ${response.status}.`);
  const ciphertext = await readCiphertext(response, options.expectedSize);
  if (response.headers.get("x-agentbox-sha256") !== options.expectedSha256 || await sha256Hex(ciphertext) !== options.expectedSha256) {
    throw new Error("Downloaded ciphertext SHA-256 does not match the expected value.");
  }
  return ciphertext;
}
async function deleteBox(options) {
  const response = await (options.fetch ?? globalThis.fetch)(capabilityUrl(options), {
    headers: authorizedHeaders(options.capability),
    method: "DELETE"
  });
  if (response.status !== 204) throw new Error(`agentbox delete failed with HTTP ${response.status}.`);
}

// src/cli.ts
var CliError = class extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.name = "CliError";
  }
};
function option(args, name, environmentName) {
  const index = args.indexOf(name);
  const value = index === -1 ? environmentName ? process.env[environmentName] : void 0 : args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError("usage", `${name} is required.`, 2);
  return value;
}
function optional(args, name, fallback, environmentName) {
  const index = args.indexOf(name);
  if (index === -1 && environmentName && process.env[environmentName]) return process.env[environmentName];
  return index === -1 ? fallback : option(args, name);
}
async function stdinBytes() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_CIPHERTEXT_BYTES) throw new Error("Input exceeds the 10 MiB limit.");
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function readBytes(path) {
  if (path === "-") return stdinBytes();
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error("Byte input must not be a symbolic link.");
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Byte input must be a regular file.");
    if (metadata.size > MAX_CIPHERTEXT_BYTES) throw new Error("Input exceeds the 10 MiB limit.");
    const bytes = new Uint8Array(await file.readFile());
    if (bytes.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error("Input exceeds the 10 MiB limit.");
    return bytes;
  } finally {
    await file.close();
  }
}
async function readSecretFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Secret input must be a regular file.");
    if (process.platform !== "win32" && (metadata.mode & 63) !== 0) {
      throw new Error("Secret input must be a protected file with no group or other access.");
    }
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
}
async function writeNewFile(path, value, mode = 384) {
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, mode);
  } catch (error) {
    const code = error.code;
    if (code === "EEXIST" || code === "ELOOP") throw new Error("Output target must not already exist.");
    throw error;
  }
  try {
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}
async function readPaymentRecovery(path, endpoint, idempotencyKey, ciphertextSha256) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let recovery;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || process.platform !== "win32" && (metadata.mode & 63) !== 0) {
      throw new Error("Payment recovery file must be a protected regular file.");
    }
    recovery = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  if (recovery.endpoint !== endpoint || recovery.idempotencyKey !== idempotencyKey || recovery.ciphertextSha256 !== ciphertextSha256 || !recovery.paymentSignature) {
    throw new Error("Payment recovery data does not match this send request.");
  }
  return recovery;
}
function shouldDiscardPaymentRecovery(error) {
  return error instanceof PaymentRejectedError && error.definitive;
}
async function discardPaymentRecovery(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}
function boxUrl(endpoint, boxId) {
  return new URL(`/v1/boxes/${encodeURIComponent(boxId)}`, endpoint).toString();
}
function assertCiphertextSize(ciphertext) {
  if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error("Encrypted ciphertext exceeds the 10 MiB limit.");
}
async function main(args) {
  if (args.length === 2 && args[0] === "--version" && args[1] === "--json") return packageIdentity;
  const [group, command] = args;
  if (group === "identity" && command === "generate") {
    const identityFile = option(args, "--identity-file");
    const identity = await generateRecipientIdentity();
    await writeNewFile(identityFile, identity.identity);
    return { identityFile, publicKey: identity.publicKey };
  }
  if (group === "identity" && command === "import") {
    return { publicKey: await recipientForIdentity(await readSecretFile(option(args, "--identity-file"))) };
  }
  if (group === "encrypt") {
    const ciphertext = await encryptForRecipient(
      await readBytes(option(args, "--input")),
      await readSecretFile(option(args, "--recipient-file"))
    );
    assertCiphertextSize(ciphertext);
    await writeNewFile(option(args, "--output"), ciphertext);
    return { ciphertextSha256: await sha256Hex(ciphertext), ciphertextSize: ciphertext.byteLength };
  }
  if (group === "decrypt") {
    const ciphertext = await readBytes(option(args, "--input"));
    if (await sha256Hex(ciphertext) !== option(args, "--sha256")) {
      throw new Error("Ciphertext SHA-256 does not match --sha256.");
    }
    const plaintext = await decryptCiphertext(ciphertext, await readSecretFile(option(args, "--identity-file")));
    await writeNewFile(option(args, "--output"), plaintext);
    return { plaintextSize: plaintext.byteLength };
  }
  if (group === "send") {
    const input = option(args, "--input");
    if (input === "-") throw new CliError("usage", "send requires a file input so retries can reproduce identical bytes.", 2);
    const idempotencyWasGenerated = !args.includes("--idempotency-key") && !process.env.AGENTBOX_IDEMPOTENCY_KEY;
    const idempotencyKey = optional(args, "--idempotency-key", crypto.randomUUID(), "AGENTBOX_IDEMPOTENCY_KEY");
    const ciphertextFile = optional(args, "--ciphertext-file", `${input}.agentbox-${idempotencyKey}.age`);
    const paymentRecoveryFile = `${ciphertextFile}.payment.json`;
    let ciphertext;
    try {
      ciphertext = await readBytes(ciphertextFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ciphertext = await encryptForRecipient(await readBytes(input), await readSecretFile(option(args, "--recipient-file")));
      assertCiphertextSize(ciphertext);
      await writeNewFile(ciphertextFile, ciphertext);
    }
    const endpoint = new URL(option(args, "--endpoint", "AGENTBOX_ENDPOINT")).toString();
    const ciphertextSha256 = await sha256Hex(ciphertext);
    let recovery = await readPaymentRecovery(paymentRecoveryFile, endpoint, idempotencyKey, ciphertextSha256);
    if (idempotencyWasGenerated) {
      process.stderr.write(`${JSON.stringify({ ciphertextFile, event: "idempotency_key", idempotencyKey })}
`);
    }
    let box;
    try {
      box = await createAndUpload({
        ciphertext,
        endpoint,
        idempotencyKey,
        maxPriceAtomic: optional(args, "--max-price-atomic", "10000", "AGENTBOX_MAX_PRICE_ATOMIC"),
        onPaymentSignature: async (paymentSignature) => {
          if (recovery && recovery.paymentSignature !== paymentSignature) {
            throw new Error("Payment retry attempted to replace its signed authorization.");
          }
          if (recovery) return;
          recovery = { ciphertextSha256, endpoint, idempotencyKey, paymentSignature };
          await writeNewFile(paymentRecoveryFile, JSON.stringify(recovery));
          process.stderr.write(`${JSON.stringify({ event: "payment_recovery", paymentRecoveryFile })}
`);
        },
        payerPrivateKey: await readSecretFile(option(args, "--payer-key-file")),
        ...recovery ? { paymentSignature: recovery.paymentSignature } : {}
      });
    } catch (error) {
      if (shouldDiscardPaymentRecovery(error) && recovery) await discardPaymentRecovery(paymentRecoveryFile);
      throw error;
    }
    const capabilitiesFile = option(args, "--capabilities-file");
    await writeNewFile(capabilitiesFile, JSON.stringify({ ...box, idempotencyKey }));
    if (recovery && !await discardPaymentRecovery(paymentRecoveryFile)) {
      process.stderr.write(`${JSON.stringify({ event: "payment_recovery_cleanup_warning", paymentRecoveryFile })}
`);
    }
    const { delete: _delete, download: _download, upload: _upload, ...metadata } = box;
    return { ...metadata, capabilitiesFile, idempotencyKey };
  }
  if (group === "inspect") {
    const endpoint = option(args, "--endpoint", "AGENTBOX_ENDPOINT");
    const boxId = option(args, "--box-id");
    return inspectBox({ boxId, capability: await readSecretFile(option(args, "--read-capability-file")), endpoint, url: boxUrl(endpoint, boxId) });
  }
  if (group === "download") {
    const endpoint = option(args, "--endpoint", "AGENTBOX_ENDPOINT");
    const boxId = option(args, "--box-id");
    const ciphertext = await downloadAndVerify({
      boxId,
      capability: await readSecretFile(option(args, "--read-capability-file")),
      endpoint,
      expectedSha256: option(args, "--sha256"),
      url: boxUrl(endpoint, boxId)
    });
    await writeNewFile(option(args, "--output"), ciphertext);
    return { ciphertextSha256: await sha256Hex(ciphertext), ciphertextSize: ciphertext.byteLength };
  }
  if (group === "receive") {
    const endpoint = option(args, "--endpoint", "AGENTBOX_ENDPOINT");
    const boxId = option(args, "--box-id");
    const capability = await readSecretFile(option(args, "--read-capability-file"));
    const url = boxUrl(endpoint, boxId);
    const inspection = await inspectBox({ boxId, capability, endpoint, url });
    const ciphertext = await downloadAndVerify({
      boxId,
      capability,
      endpoint,
      expectedSha256: inspection.ciphertextSha256,
      expectedSize: inspection.ciphertextSize,
      url
    });
    const plaintext = await decryptCiphertext(ciphertext, await readSecretFile(option(args, "--identity-file")));
    await writeNewFile(option(args, "--output"), plaintext);
    return { plaintextSize: plaintext.byteLength };
  }
  if (group === "delete") {
    const endpoint = option(args, "--endpoint", "AGENTBOX_ENDPOINT");
    const boxId = option(args, "--box-id");
    await deleteBox({
      boxId,
      capability: await readSecretFile(option(args, "--delete-capability-file")),
      endpoint,
      url: boxUrl(endpoint, boxId)
    });
    return { deleted: true };
  }
  throw new CliError("usage", "Usage: identity generate|import, encrypt, decrypt, send, inspect, download, receive, or delete.", 2);
}
async function run(args) {
  try {
    process.stdout.write(`${JSON.stringify(await main(args))}
`);
    return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.code : "cli_error";
    const message = error instanceof Error ? error.message : "agentbox CLI failed.";
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}
`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

// src/index.ts
var packageIdentity = Object.freeze({ name: "@agtbox/cli", version: "0.1.1" });
export {
  CliError,
  PaymentRejectedError,
  REQUEST_COMMITMENT_HEADER,
  assertCiphertextSize,
  canonicalCreateRequest,
  createAndUpload,
  createRequestCommitment,
  decryptCiphertext,
  deleteBox,
  downloadAndVerify,
  encryptForRecipient,
  generateRecipientIdentity,
  inspectBox,
  main,
  packageIdentity,
  recipientForIdentity,
  run,
  sha256Hex,
  shouldDiscardPaymentRecovery
};
