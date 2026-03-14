"""Shared test fixtures for AI service tests."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


@pytest.fixture
def ed25519_keypair():
    """Generate a fresh Ed25519 keypair for testing."""
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    public_pem = private_key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    return private_pem, public_pem


@pytest.fixture
def make_jwt(ed25519_keypair):
    """Factory to create signed Ed25519 JWTs for testing."""
    private_pem, _ = ed25519_keypair

    def _make(
        sub: str = "test-agent-1",
        aud: str = "hill90-model-router",
        iss: str = "hill90-api",
        exp: int | None = None,
        iat: int | None = None,
        jti: str = "test-jti-001",
        owner: str | None = None,
    ) -> str:
        now = int(time.time())
        payload = {
            "sub": sub,
            "aud": aud,
            "iss": iss,
            "exp": exp if exp is not None else now + 3600,
            "iat": iat if iat is not None else now,
            "jti": jti,
            **({"owner": owner} if owner else {}),
        }
        return pyjwt.encode(payload, private_pem, algorithm="EdDSA")

    return _make


@pytest.fixture
def mock_db_pool():
    """Mock asyncpg connection pool."""
    pool = AsyncMock()
    conn = AsyncMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn
