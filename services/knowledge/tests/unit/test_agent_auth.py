"""Unit tests for Ed25519 JWT agent authentication."""

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from app.middleware.agent_auth import verify_agent_token, AgentClaims, AuthError


@pytest.fixture()
def ed25519_keypair() -> tuple[bytes, bytes]:
    """Generate an Ed25519 key pair for testing."""
    private_key = Ed25519PrivateKey.generate()
    private_pem = private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    public_pem = private_key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    return private_pem, public_pem


def _make_token(
    private_pem: bytes,
    sub: str = "test-agent",
    iss: str = "hill90-api",
    aud: str = "hill90-akm",
    exp_offset: int = 3600,
    jti: str | None = None,
    scopes: list[str] | None = None,
) -> str:
    """Helper to create a signed JWT."""
    now = int(time.time())
    payload = {
        "sub": sub,
        "iss": iss,
        "aud": aud,
        "exp": now + exp_offset,
        "iat": now,
        "jti": jti or str(uuid.uuid4()),
        "scopes": scopes or ["akm:read", "akm:write"],
    }
    return jwt.encode(payload, private_pem, algorithm="EdDSA")


class TestAgentAuth:
    def test_valid_token_accepted(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem)
        claims = verify_agent_token(token, public_pem)
        assert isinstance(claims, AgentClaims)
        assert claims.sub == "test-agent"
        assert "akm:read" in claims.scopes

    def test_expired_token_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, exp_offset=-3600)
        with pytest.raises(AuthError, match="expired"):
            verify_agent_token(token, public_pem)

    def test_wrong_issuer_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, iss="wrong-issuer")
        with pytest.raises(AuthError, match="issuer"):
            verify_agent_token(token, public_pem)

    def test_wrong_audience_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, aud="wrong-audience")
        with pytest.raises(AuthError, match="audience"):
            verify_agent_token(token, public_pem)

    def test_tampered_token_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem)
        # Flip a character in the signature portion
        tampered = token[:-5] + "XXXXX"
        with pytest.raises(AuthError):
            verify_agent_token(tampered, public_pem)


class TestAgentScope:
    def test_shared_write_without_scope_403(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """Agent without akm:shared-write scope cannot write to shared namespace."""
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, scopes=["akm:read", "akm:write"])
        claims = verify_agent_token(token, public_pem)
        assert "akm:shared-write" not in claims.scopes

    def test_shared_write_with_scope_ok(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """Agent with akm:shared-write scope can write to shared namespace."""
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, scopes=["akm:read", "akm:write", "akm:shared-write"])
        claims = verify_agent_token(token, public_pem)
        assert "akm:shared-write" in claims.scopes

    def test_cross_agent_read_403(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """An agent's token only grants access to its own namespace (sub claim)."""
        private_pem, public_pem = ed25519_keypair
        token = _make_token(private_pem, sub="agent-a")
        claims = verify_agent_token(token, public_pem)
        # The claims.sub should be agent-a, not agent-b
        assert claims.sub == "agent-a"
        assert claims.sub != "agent-b"


class TestTokenRevocation:
    def test_revoked_jti_rejected(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        jti = str(uuid.uuid4())
        token = _make_token(private_pem, jti=jti)
        revoked_jtis = {jti}
        with pytest.raises(AuthError, match="revoked"):
            verify_agent_token(token, public_pem, revoked_jtis=revoked_jtis)

    def test_unrevoked_jti_allowed(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        private_pem, public_pem = ed25519_keypair
        jti = str(uuid.uuid4())
        token = _make_token(private_pem, jti=jti)
        revoked_jtis: set[str] = set()
        claims = verify_agent_token(token, public_pem, revoked_jtis=revoked_jtis)
        assert claims.jti == jti

    def test_revocation_cache_populated(self, ed25519_keypair: tuple[bytes, bytes]) -> None:
        """Multiple revoked JTIs are all rejected."""
        private_pem, public_pem = ed25519_keypair
        jti1 = str(uuid.uuid4())
        jti2 = str(uuid.uuid4())
        revoked = {jti1, jti2}
        for jti in [jti1, jti2]:
            token = _make_token(private_pem, jti=jti)
            with pytest.raises(AuthError, match="revoked"):
                verify_agent_token(token, public_pem, revoked_jtis=revoked)
