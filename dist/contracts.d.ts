export declare const MAX_CIPHERTEXT_BYTES: number;
export declare const MAX_CREATE_RESPONSE_BYTES: number;
export declare const MAX_CAPACITY_RECLAIM_RETRIES = 83;
export declare const BASE_MAINNET_NETWORK = "eip155:8453";
export declare const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export declare const CREATE_PRICE_USDC_ATOMIC = "10000";
export declare const EXPECTED_PAYMENT_RECIPIENT = "0xb5363EDDE479640886cf708BC596F2aED09806A8";
export interface CreateBoxInput {
    ciphertextSha256: string;
    ciphertextSize: number;
}
