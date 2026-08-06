export interface RecipientIdentity {
    identity: string;
    publicKey: string;
}
export declare function generateRecipientIdentity(): Promise<RecipientIdentity>;
export declare function recipientForIdentity(identity: string): Promise<string>;
export declare function encryptForRecipient(plaintext: Uint8Array, publicKey: string): Promise<Uint8Array>;
export declare function decryptCiphertext(ciphertext: Uint8Array, identity: string): Promise<Uint8Array>;
export declare function sha256Hex(bytes: Uint8Array): Promise<string>;
