/**
 * AES-256-GCM encryption for provider API keys.
 *
 * Encrypt on write (API service), decrypt for validation passthrough.
 * The AI service has its own decrypt-only module (crypto.py).
 *
 * Key: 32-byte hex string from PROVIDER_KEY_ENCRYPTION_KEY env var.
 * Nonce: 12 bytes, randomly generated per encryption.
 * Output: ciphertext with 16-byte auth tag appended.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function getKeyBuffer(hexKey: string): Buffer {
  const buf = Buffer.from(hexKey, 'hex');
  if (buf.length !== 32) {
    throw new Error('PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return buf;
}

export interface EncryptedKey {
  encrypted: Buffer;
  nonce: Buffer;
}

export function encryptProviderKey(plaintext: string, hexKey: string): EncryptedKey {
  const key = getKeyBuffer(hexKey);
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([ciphertext, tag]),
    nonce,
  };
}

export function decryptProviderKey(encrypted: Buffer, nonce: Buffer, hexKey: string): string {
  const key = getKeyBuffer(hexKey);
  if (encrypted.length < TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }
  const ciphertext = encrypted.subarray(0, encrypted.length - TAG_LENGTH);
  const tag = encrypted.subarray(encrypted.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
