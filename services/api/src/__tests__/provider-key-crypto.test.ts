import { encryptProviderKey, decryptProviderKey } from '../services/provider-key-crypto';
import crypto from 'crypto';

const TEST_KEY = crypto.randomBytes(32).toString('hex');

describe('provider-key-crypto', () => {
  it('encrypt/decrypt roundtrip', () => {
    const plaintext = 'sk-test-key-abc123';
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    const result = decryptProviderKey(encrypted, nonce, TEST_KEY);
    expect(result).toBe(plaintext);
  });

  it('handles long API keys', () => {
    const plaintext = 'sk-' + 'a'.repeat(200);
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    const result = decryptProviderKey(encrypted, nonce, TEST_KEY);
    expect(result).toBe(plaintext);
  });

  it('different nonces produce different ciphertexts', () => {
    const plaintext = 'sk-test-key-abc123';
    const r1 = encryptProviderKey(plaintext, TEST_KEY);
    const r2 = encryptProviderKey(plaintext, TEST_KEY);
    expect(r1.encrypted.equals(r2.encrypted)).toBe(false);
    expect(r1.nonce.equals(r2.nonce)).toBe(false);
    // Both decrypt to same value
    expect(decryptProviderKey(r1.encrypted, r1.nonce, TEST_KEY)).toBe(plaintext);
    expect(decryptProviderKey(r2.encrypted, r2.nonce, TEST_KEY)).toBe(plaintext);
  });

  it('wrong key fails to decrypt', () => {
    const plaintext = 'sk-test-key-abc123';
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    const wrongKey = crypto.randomBytes(32).toString('hex');
    expect(() => decryptProviderKey(encrypted, nonce, wrongKey)).toThrow();
  });

  it('tampered ciphertext fails to decrypt', () => {
    const plaintext = 'sk-test-key-abc123';
    const { encrypted, nonce } = encryptProviderKey(plaintext, TEST_KEY);
    // Flip a byte in the ciphertext
    const tampered = Buffer.from(encrypted);
    tampered[0] ^= 0xff;
    expect(() => decryptProviderKey(tampered, nonce, TEST_KEY)).toThrow();
  });

  it('rejects invalid key length', () => {
    expect(() => encryptProviderKey('test', 'aabbcc')).toThrow(
      'PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes'
    );
  });
});
