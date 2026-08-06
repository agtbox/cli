export interface BoxResponse {
    boxId: string;
    createdAt: string;
    delete: {
        capability: string;
        url: string;
    };
    download: {
        capability: string;
        url: string;
    };
    expiresAt: string;
    upload: {
        capability: string;
        url: string;
    };
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
export declare class PaymentRejectedError extends Error {
    readonly definitive: boolean;
    constructor(message: string, definitive?: boolean);
}
export declare function createAndUpload(options: CreateAndUploadOptions): Promise<BoxResponse>;
export declare function inspectBox(options: CapabilityRequest): Promise<BoxInspection>;
export declare function downloadAndVerify(options: CapabilityRequest & {
    expectedSha256: string;
    expectedSize?: number;
}): Promise<Uint8Array>;
export declare function deleteBox(options: CapabilityRequest): Promise<void>;
