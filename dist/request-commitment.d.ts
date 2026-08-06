import type { CreateBoxInput } from "./contracts.js";
export declare const REQUEST_COMMITMENT_HEADER = "x-agentbox-request-commitment";
export declare function canonicalCreateRequest(input: CreateBoxInput): string;
export declare function createRequestCommitment(options: {
    idempotencyKey: string;
    input: CreateBoxInput;
    origin: string;
}): string;
