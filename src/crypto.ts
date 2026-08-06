import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";

export interface RecipientIdentity {
  identity: string;
  publicKey: string;
}

export async function generateRecipientIdentity(): Promise<RecipientIdentity> {
  const identity = await generateIdentity();
  return { identity, publicKey: await identityToRecipient(identity) };
}

export async function recipientForIdentity(identity: string): Promise<string> {
  return identityToRecipient(identity);
}

export async function encryptForRecipient(plaintext: Uint8Array, publicKey: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(publicKey);
  return encrypter.encrypt(plaintext);
}

export async function decryptCiphertext(ciphertext: Uint8Array, identity: string): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(ciphertext);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
