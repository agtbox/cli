import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

import {
  BASE_MAINNET_NETWORK,
  BASE_MAINNET_USDC,
  CREATE_PRICE_USDC_ATOMIC,
  EXPECTED_PAYMENT_RECIPIENT,
  MAX_CAPACITY_RECLAIM_RETRIES,
  MAX_CIPHERTEXT_BYTES,
  MAX_CREATE_RESPONSE_BYTES,
} from "./contracts.js";
import { sha256Hex } from "./crypto.js";
import { canonicalCreateRequest, createRequestCommitment, REQUEST_COMMITMENT_HEADER } from "./request-commitment.js";

export interface BoxResponse {
  boxId: string;
  createdAt: string;
  delete: { capability: string; url: string };
  download: { capability: string; url: string };
  expiresAt: string;
  upload: { capability: string; url: string };
}

export interface BoxInspection {
  ciphertextSha256: string;
  ciphertextSize: number;
  createdAt: string;
  expiresAt: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CapabilityRequest {
  boxId: string;
  capability: string;
  endpoint: string;
  fetch?: FetchLike;
  url: string;
}

export interface CreateAndUploadOptions {
  ciphertext: Uint8Array;
  endpoint: string;
  fetch?: FetchLike;
  idempotencyKey: string;
  maxPriceAtomic: string;
  onPaymentSignature?: (paymentSignature: string) => Promise<void> | void;
  payerPrivateKey: `0x${string}`;
  paymentSignature?: string;
}

export class PaymentRejectedError extends Error {
  public constructor(message: string, public readonly definitive = false) {
    super(message);
    this.name = "PaymentRejectedError";
  }
}

function endpointUrl(endpoint: string, path: string): string {
  const base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  if (base.protocol !== "https:") throw new Error("agentbox endpoint must use HTTPS.");
  return new URL(path, base).toString();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHandoffUrl(value: unknown, expectedOrigin: string, boxId: string): boolean {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === expectedOrigin
      && url.pathname === `/v1/boxes/${encodeURIComponent(boxId)}` && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function validateResponse(value: unknown, expectedOrigin: string): BoxResponse {
  if (!value || typeof value !== "object") throw new Error("agentbox returned an invalid create response.");
  const box = value as Partial<BoxResponse>;
  if (!isNonEmptyString(box.boxId) || !isNonEmptyString(box.createdAt) || !isNonEmptyString(box.expiresAt)
    || !isNonEmptyString(box.upload?.capability) || !isNonEmptyString(box.upload?.url)
    || !isNonEmptyString(box.download?.capability) || !isNonEmptyString(box.download?.url)
    || !isNonEmptyString(box.delete?.capability) || !isNonEmptyString(box.delete?.url)) {
    throw new Error("agentbox returned an incomplete create response.");
  }
  if (!isHandoffUrl(box.upload.url, expectedOrigin, box.boxId)
    || !isHandoffUrl(box.download.url, expectedOrigin, box.boxId)
    || !isHandoffUrl(box.delete.url, expectedOrigin, box.boxId)) {
    throw new Error("agentbox returned unsafe handoff URLs.");
  }
  return {
    boxId: box.boxId,
    createdAt: box.createdAt,
    delete: { capability: box.delete.capability, url: box.delete.url },
    download: { capability: box.download.capability, url: box.download.url },
    expiresAt: box.expiresAt,
    upload: { capability: box.upload.capability, url: box.upload.url },
  };
}

function capabilityUrl(options: CapabilityRequest): string {
  const expectedOrigin = new URL(endpointUrl(options.endpoint, "/v1/boxes")).origin;
  if (!isHandoffUrl(options.url, expectedOrigin, options.boxId)) {
    throw new Error("agentbox capability URL does not match the trusted box.");
  }
  return new URL(options.url).toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CREATE_RESPONSE_BYTES) {
    throw new Error("agentbox create response exceeds the 16 KiB limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("agentbox returned an invalid create response.");
  const chunks: Uint8Array[] = [];
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

async function isCapacityReclaiming(response: Response): Promise<boolean> {
  try {
    const body = await readBoundedJson(response) as { error?: { code?: unknown } };
    return body.error?.code === "capacity_reclaiming";
  } catch {
    return false;
  }
}

function paymentRetryFetch(fetch: FetchLike, paymentSignature: string): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("payment-signature", paymentSignature);
    return fetch(input, { ...init, headers });
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return Uint8Array.from(bytes).buffer;
}

function recordingPaymentFetch(fetch: FetchLike, callback: CreateAndUploadOptions["onPaymentSignature"]): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    const signature = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
    if (signature) await callback?.(signature);
    return fetch(input, init);
  };
}

export async function createAndUpload(options: CreateAndUploadOptions): Promise<BoxResponse> {
  if (!/^[1-9][0-9]*$/u.test(options.maxPriceAtomic)
    || BigInt(options.maxPriceAtomic) < BigInt(CREATE_PRICE_USDC_ATOMIC)) {
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
    message: createRequestCommitment({ idempotencyKey: options.idempotencyKey, input, origin: new URL(createUrl).origin }),
  });
  let paymentSignature = options.paymentSignature;
  const paymentFetch = paymentSignature
    ? paymentRetryFetch(fetch, paymentSignature)
    : wrapFetchWithPaymentFromConfig(recordingPaymentFetch(fetch, async (signature) => {
      paymentSignature = signature;
      await options.onPaymentSignature?.(signature);
    }) as typeof globalThis.fetch, {
      paymentRequirementsSelector: (_version, requirements) => {
        const selected = requirements.find((requirement) => requirement.scheme === "exact"
          && requirement.network === BASE_MAINNET_NETWORK
          && requirement.asset.toLowerCase() === BASE_MAINNET_USDC.toLowerCase());
        if (!selected || selected.payTo.toLowerCase() !== EXPECTED_PAYMENT_RECIPIENT.toLowerCase()) {
          throw new Error("agentbox payment challenge is incompatible.");
        }
        if (BigInt(selected.amount) > BigInt(options.maxPriceAtomic)) {
          throw new Error("agentbox payment exceeds the configured maximum.");
        }
        return selected;
      },
      schemes: [{ client: new ExactEvmScheme(account), network: BASE_MAINNET_NETWORK }],
    });
  let create: Response | undefined;
  for (let attempt = 0; attempt <= MAX_CAPACITY_RECLAIM_RETRIES; attempt += 1) {
    create = await (paymentSignature ? paymentRetryFetch(fetch, paymentSignature) : paymentFetch)(createUrl, {
      body: canonicalCreateRequest(input),
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey,
        [REQUEST_COMMITMENT_HEADER]: requestCommitment,
      },
      method: "POST",
    });
    if (create.status !== 503 || !(await isCapacityReclaiming(create)) || attempt === MAX_CAPACITY_RECLAIM_RETRIES) break;
  }
  if (!create) throw new Error("agentbox create did not return a response.");
  if (create.status === 402) {
    throw new PaymentRejectedError("agentbox rejected the payment authorization.", create.headers.has("payment-response"));
  }
  if (create.status !== 201) throw new Error(`agentbox create failed with HTTP ${create.status}.`);
  const box = validateResponse(await readBoundedJson(create), new URL(createUrl).origin);
  const upload = await fetch(capabilityUrl({
    boxId: box.boxId, capability: box.upload.capability, endpoint: options.endpoint, url: box.upload.url,
  }), {
    body: exactArrayBuffer(options.ciphertext),
    headers: {
      authorization: `Bearer ${box.upload.capability}`,
      "content-length": String(options.ciphertext.byteLength),
      "content-type": "application/octet-stream",
    },
    method: "PUT",
  });
  if (upload.status === 409) {
    const existing = await inspectBox({
      boxId: box.boxId, capability: box.download.capability, endpoint: options.endpoint, fetch, url: box.download.url,
    });
    if (existing.ciphertextSize === options.ciphertext.byteLength && existing.ciphertextSha256 === input.ciphertextSha256) return box;
  }
  if (upload.status !== 204) throw new Error(`agentbox upload failed with HTTP ${upload.status}.`);
  return box;
}

function authorizedHeaders(capability: string): HeadersInit {
  return { authorization: `Bearer ${capability}` };
}

export async function inspectBox(options: CapabilityRequest): Promise<BoxInspection> {
  const response = await (options.fetch ?? globalThis.fetch)(capabilityUrl(options), {
    headers: authorizedHeaders(options.capability), method: "HEAD",
  });
  if (response.status !== 200) throw new Error(`agentbox inspect failed with HTTP ${response.status}.`);
  const ciphertextSize = Number(response.headers.get("content-length"));
  const ciphertextSha256 = response.headers.get("x-agentbox-sha256");
  const createdAt = response.headers.get("x-agentbox-created-at");
  const expiresAt = response.headers.get("x-agentbox-expires-at");
  if (!Number.isSafeInteger(ciphertextSize) || ciphertextSize < 1 || ciphertextSize > MAX_CIPHERTEXT_BYTES
    || !/^[a-f0-9]{64}$/u.test(ciphertextSha256 ?? "") || !createdAt || !expiresAt) {
    throw new Error("agentbox returned incomplete ciphertext metadata.");
  }
  return { ciphertextSha256: ciphertextSha256!, ciphertextSize, createdAt, expiresAt };
}

async function readCiphertext(response: Response, expectedSize: number | undefined): Promise<Uint8Array> {
  const maximumSize = expectedSize ?? MAX_CIPHERTEXT_BYTES;
  if (!Number.isSafeInteger(maximumSize) || maximumSize < 1 || maximumSize > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Expected ciphertext size is outside the allowed limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("agentbox download response has no ciphertext body.");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maximumSize - received) {
        throw new Error(`Downloaded ciphertext exceeds the ${expectedSize === undefined ? "10 MiB limit" : "expected size"}.`);
      }
      chunks.push(next.value);
      received += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedSize !== undefined && received !== expectedSize) {
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

export async function downloadAndVerify(options: CapabilityRequest & { expectedSha256: string; expectedSize?: number }): Promise<Uint8Array> {
  const response = await (options.fetch ?? globalThis.fetch)(capabilityUrl(options), {
    headers: authorizedHeaders(options.capability), method: "GET",
  });
  if (response.status !== 200) throw new Error(`agentbox download failed with HTTP ${response.status}.`);
  const ciphertext = await readCiphertext(response, options.expectedSize);
  if (response.headers.get("x-agentbox-sha256") !== options.expectedSha256
    || (await sha256Hex(ciphertext)) !== options.expectedSha256) {
    throw new Error("Downloaded ciphertext SHA-256 does not match the expected value.");
  }
  return ciphertext;
}

export async function deleteBox(options: CapabilityRequest): Promise<void> {
  const response = await (options.fetch ?? globalThis.fetch)(capabilityUrl(options), {
    headers: authorizedHeaders(options.capability), method: "DELETE",
  });
  if (response.status !== 204) throw new Error(`agentbox delete failed with HTTP ${response.status}.`);
}
