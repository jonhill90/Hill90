"""Tests for AES-256-GCM provider key decryption."""

import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.crypto import decrypt_provider_key

# Generate a stable test key
TEST_KEY_HEX = os.urandom(32).hex()


def _encrypt(plaintext: str, hex_key: str) -> tuple[bytes, bytes]:
    """Encrypt using the same format the API service produces."""
    key = bytes.fromhex(hex_key)
    nonce = os.urandom(12)
    aesgcm = AESGCM(key)
    # AESGCM.encrypt returns ciphertext + tag concatenated
    encrypted = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    return encrypted, nonce


def test_encrypt_decrypt_roundtrip():
    plaintext = "sk-test-key-abc123"
    encrypted, nonce = _encrypt(plaintext, TEST_KEY_HEX)
    result = decrypt_provider_key(encrypted, nonce, TEST_KEY_HEX)
    assert result == plaintext


def test_handles_long_api_keys():
    plaintext = "sk-" + "a" * 200
    encrypted, nonce = _encrypt(plaintext, TEST_KEY_HEX)
    result = decrypt_provider_key(encrypted, nonce, TEST_KEY_HEX)
    assert result == plaintext


def test_different_nonces():
    plaintext = "sk-test-key-abc123"
    e1, n1 = _encrypt(plaintext, TEST_KEY_HEX)
    e2, n2 = _encrypt(plaintext, TEST_KEY_HEX)
    assert e1 != e2
    assert n1 != n2
    assert decrypt_provider_key(e1, n1, TEST_KEY_HEX) == plaintext
    assert decrypt_provider_key(e2, n2, TEST_KEY_HEX) == plaintext


def test_decrypt_wrong_key_fails():
    plaintext = "sk-test-key-abc123"
    encrypted, nonce = _encrypt(plaintext, TEST_KEY_HEX)
    wrong_key = os.urandom(32).hex()
    with pytest.raises(Exception):
        decrypt_provider_key(encrypted, nonce, wrong_key)


def test_decrypt_tampered_ciphertext_fails():
    plaintext = "sk-test-key-abc123"
    encrypted, nonce = _encrypt(plaintext, TEST_KEY_HEX)
    tampered = bytearray(encrypted)
    tampered[0] ^= 0xFF
    with pytest.raises(Exception):
        decrypt_provider_key(bytes(tampered), nonce, TEST_KEY_HEX)


def test_rejects_invalid_key_length():
    encrypted, nonce = _encrypt("test", TEST_KEY_HEX)
    with pytest.raises(ValueError, match="32 bytes"):
        decrypt_provider_key(encrypted, nonce, "aabbcc")
