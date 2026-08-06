import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";

import { MAX_CIPHERTEXT_BYTES } from "./contracts.js";
import { decryptCiphertext, encryptForRecipient, generateRecipientIdentity, recipientForIdentity, sha256Hex } from "./crypto.js";
import { createAndUpload, deleteBox, downloadAndVerify, inspectBox, PaymentRejectedError } from "./handoff.js";
import { packageIdentity } from "./index.js";

interface PaymentRecovery {
  ciphertextSha256: string;
  endpoint: string;
  idempotencyKey: string;
  paymentSignature: string;
}

export class CliError extends Error {
  public constructor(public readonly code: string, message: string, public readonly exitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

function option(args: string[], name: string, environmentName?: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? (environmentName ? process.env[environmentName] : undefined) : args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError("usage", `${name} is required.`, 2);
  return value;
}

function optional(args: string[], name: string, fallback: string, environmentName?: string): string {
  const index = args.indexOf(name);
  if (index === -1 && environmentName && process.env[environmentName]) return process.env[environmentName]!;
  return index === -1 ? fallback : option(args, name);
}

async function stdinBytes(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_CIPHERTEXT_BYTES) throw new Error("Input exceeds the 10 MiB limit.");
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readBytes(path: string): Promise<Uint8Array> {
  if (path === "-") return stdinBytes();
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Byte input must not be a symbolic link.");
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

async function readSecretFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Secret input must be a regular file.");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Secret input must be a protected file with no group or other access.");
    }
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
}

async function writeNewFile(path: string, value: string | Uint8Array, mode = 0o600): Promise<void> {
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") throw new Error("Output target must not already exist.");
    throw error;
  }
  try {
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}

async function readPaymentRecovery(
  path: string,
  endpoint: string,
  idempotencyKey: string,
  ciphertextSha256: string,
): Promise<PaymentRecovery | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let recovery: Partial<PaymentRecovery>;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("Payment recovery file must be a protected regular file.");
    }
    recovery = JSON.parse(await file.readFile("utf8")) as Partial<PaymentRecovery>;
  } finally {
    await file.close();
  }
  if (recovery.endpoint !== endpoint || recovery.idempotencyKey !== idempotencyKey
    || recovery.ciphertextSha256 !== ciphertextSha256 || !recovery.paymentSignature) {
    throw new Error("Payment recovery data does not match this send request.");
  }
  return recovery as PaymentRecovery;
}

export function shouldDiscardPaymentRecovery(error: unknown): boolean {
  return error instanceof PaymentRejectedError && error.definitive;
}

async function discardPaymentRecovery(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function boxUrl(endpoint: string, boxId: string): string {
  return new URL(`/v1/boxes/${encodeURIComponent(boxId)}`, endpoint).toString();
}

export function assertCiphertextSize(ciphertext: Uint8Array): void {
  if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error("Encrypted ciphertext exceeds the 10 MiB limit.");
}

export async function main(args: string[]): Promise<unknown> {
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
      await readSecretFile(option(args, "--recipient-file")),
    );
    assertCiphertextSize(ciphertext);
    await writeNewFile(option(args, "--output"), ciphertext);
    return { ciphertextSha256: await sha256Hex(ciphertext), ciphertextSize: ciphertext.byteLength };
  }
  if (group === "decrypt") {
    const ciphertext = await readBytes(option(args, "--input"));
    if ((await sha256Hex(ciphertext)) !== option(args, "--sha256")) {
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
    let ciphertext: Uint8Array;
    try {
      ciphertext = await readBytes(ciphertextFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ciphertext = await encryptForRecipient(await readBytes(input), await readSecretFile(option(args, "--recipient-file")));
      assertCiphertextSize(ciphertext);
      await writeNewFile(ciphertextFile, ciphertext);
    }
    const endpoint = new URL(option(args, "--endpoint", "AGENTBOX_ENDPOINT")).toString();
    const ciphertextSha256 = await sha256Hex(ciphertext);
    let recovery = await readPaymentRecovery(paymentRecoveryFile, endpoint, idempotencyKey, ciphertextSha256);
    if (idempotencyWasGenerated) {
      process.stderr.write(`${JSON.stringify({ ciphertextFile, event: "idempotency_key", idempotencyKey })}\n`);
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
          process.stderr.write(`${JSON.stringify({ event: "payment_recovery", paymentRecoveryFile })}\n`);
        },
        payerPrivateKey: await readSecretFile(option(args, "--payer-key-file")) as `0x${string}`,
        ...(recovery ? { paymentSignature: recovery.paymentSignature } : {}),
      });
    } catch (error) {
      if (shouldDiscardPaymentRecovery(error) && recovery) await discardPaymentRecovery(paymentRecoveryFile);
      throw error;
    }
    const capabilitiesFile = option(args, "--capabilities-file");
    await writeNewFile(capabilitiesFile, JSON.stringify({ ...box, idempotencyKey }));
    if (recovery && !(await discardPaymentRecovery(paymentRecoveryFile))) {
      process.stderr.write(`${JSON.stringify({ event: "payment_recovery_cleanup_warning", paymentRecoveryFile })}\n`);
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
      url: boxUrl(endpoint, boxId),
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
      boxId, capability, endpoint, expectedSha256: inspection.ciphertextSha256, expectedSize: inspection.ciphertextSize, url,
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
      url: boxUrl(endpoint, boxId),
    });
    return { deleted: true };
  }
  throw new CliError("usage", "Usage: identity generate|import, encrypt, decrypt, send, inspect, download, receive, or delete.", 2);
}

export async function run(args: string[]): Promise<number> {
  try {
    process.stdout.write(`${JSON.stringify(await main(args))}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.code : "cli_error";
    const message = error instanceof Error ? error.message : "agentbox CLI failed.";
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}
