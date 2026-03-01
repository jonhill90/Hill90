"""AES-256-GCM decryption for provider API keys.

Decrypt-only module for the AI service. The API service encrypts keys
on write; this module decrypts them for inference and validation.

Format: ciphertext || auth_tag (16 bytes), separate 12-byte nonce.
"""

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TAG_LENGTH = 16


def decrypt_provider_key(encrypted: bytes, nonce: bytes, hex_key: str) -> str:
    """Decrypt AES-256-GCM encrypted provider key.

    Args:
        encrypted: Ciphertext with 16-byte auth tag appended.
        nonce: 12-byte nonce used during encryption.
        hex_key: 32-byte key as 64-char hex string.

    Returns:
        Decrypted plaintext API key.

    Raises:
        ValueError: If key is not 32 bytes.
        cryptography.exceptions.InvalidTag: If ciphertext is tampered.
    """
    key = bytes.fromhex(hex_key)
    if len(key) != 32:
        raise ValueError("PROVIDER_KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars)")

    # AESGCM expects ciphertext + tag concatenated (which is our format)
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, encrypted, None)
    return plaintext.decode("utf-8")
