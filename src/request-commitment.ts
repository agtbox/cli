import type { CreateBoxInput } from "./contracts.js";

export const REQUEST_COMMITMENT_HEADER = "x-agentbox-request-commitment";

export function canonicalCreateRequest(input: CreateBoxInput): string {
  return JSON.stringify({ ciphertextSha256: input.ciphertextSha256, ciphertextSize: input.ciphertextSize });
}

export function createRequestCommitment(options: {
  idempotencyKey: string;
  input: CreateBoxInput;
  origin: string;
}): string {
  return JSON.stringify({
    body: { ciphertextSha256: options.input.ciphertextSha256, ciphertextSize: options.input.ciphertextSize },
    idempotencyKey: options.idempotencyKey,
    method: "POST",
    resource: new URL("/v1/boxes", options.origin).toString(),
    version: "agentbox-request-v1",
  });
}
