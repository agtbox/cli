export const packageIdentity = Object.freeze({ name: "@agtbox/cli", version: "0.1.0" } as const);

export { assertCiphertextSize, CliError, main, run, shouldDiscardPaymentRecovery } from "./cli.js";
export { decryptCiphertext, encryptForRecipient, generateRecipientIdentity, recipientForIdentity, sha256Hex } from "./crypto.js";
export {
  createAndUpload,
  deleteBox,
  downloadAndVerify,
  inspectBox,
  PaymentRejectedError,
  type BoxInspection,
  type BoxResponse,
  type CapabilityRequest,
  type CreateAndUploadOptions,
  type FetchLike,
} from "./handoff.js";
export { canonicalCreateRequest, createRequestCommitment, REQUEST_COMMITMENT_HEADER } from "./request-commitment.js";
