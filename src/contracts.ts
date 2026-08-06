export const MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024;
export const MAX_CREATE_RESPONSE_BYTES = 16 * 1024;
export const MAX_CAPACITY_RECLAIM_RETRIES = 83;
export const BASE_MAINNET_NETWORK = "eip155:8453";
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const CREATE_PRICE_USDC_ATOMIC = "10000";
export const EXPECTED_PAYMENT_RECIPIENT = "0xb5363EDDE479640886cf708BC596F2aED09806A8";

export interface CreateBoxInput {
  ciphertextSha256: string;
  ciphertextSize: number;
}
