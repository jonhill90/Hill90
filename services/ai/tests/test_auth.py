"""Tests for Ed25519 JWT authentication in the AI service."""

import time

import pytest

from app.auth import AuthError, verify_model_router_token


class TestVerifyModelRouterToken:
    """JWT verification for model-router tokens."""

    def test_valid_token(self, ed25519_keypair, make_jwt):
        """Valid model-router token is accepted and claims are returned."""
        _, public_pem = ed25519_keypair
        token = make_jwt()
        claims = verify_model_router_token(token, public_pem)
        assert claims.sub == "test-agent-1"
        assert claims.aud == "hill90-model-router"
        assert claims.iss == "hill90-api"
        assert claims.jti == "test-jti-001"

    def test_rejects_expired_token(self, ed25519_keypair, make_jwt):
        """Expired token raises AuthError."""
        _, public_pem = ed25519_keypair
        token = make_jwt(exp=int(time.time()) - 3600)
        with pytest.raises(AuthError, match="token expired"):
            verify_model_router_token(token, public_pem)

    def test_rejects_wrong_audience(self, ed25519_keypair, make_jwt):
        """Token with wrong audience raises AuthError."""
        _, public_pem = ed25519_keypair
        token = make_jwt(aud="hill90-akm")
        with pytest.raises(AuthError, match="invalid audience"):
            verify_model_router_token(token, public_pem)

    def test_rejects_wrong_issuer(self, ed25519_keypair, make_jwt):
        """Token with wrong issuer raises AuthError."""
        _, public_pem = ed25519_keypair
        token = make_jwt(iss="unknown-issuer")
        with pytest.raises(AuthError, match="invalid issuer"):
            verify_model_router_token(token, public_pem)

    def test_rejects_revoked_jti(self, ed25519_keypair, make_jwt):
        """Token with revoked JTI raises AuthError."""
        _, public_pem = ed25519_keypair
        token = make_jwt(jti="revoked-jti-123")
        revoked = {"revoked-jti-123"}
        with pytest.raises(AuthError, match="token revoked"):
            verify_model_router_token(token, public_pem, revoked_jtis=revoked)

    def test_accepts_non_revoked_jti(self, ed25519_keypair, make_jwt):
        """Token with non-revoked JTI passes when revocation set is present."""
        _, public_pem = ed25519_keypair
        token = make_jwt(jti="good-jti")
        revoked = {"some-other-jti"}
        claims = verify_model_router_token(token, public_pem, revoked_jtis=revoked)
        assert claims.jti == "good-jti"

    def test_rejects_malformed_token(self, ed25519_keypair):
        """Malformed token raises AuthError."""
        _, public_pem = ed25519_keypair
        with pytest.raises(AuthError, match="invalid token"):
            verify_model_router_token("not.a.jwt", public_pem)

    def test_rejects_missing_claims(self, ed25519_keypair):
        """Token missing required claims raises AuthError."""
        import jwt as pyjwt
        private_pem, public_pem = ed25519_keypair
        # Missing sub, jti
        payload = {
            "aud": "hill90-model-router",
            "iss": "hill90-api",
            "exp": int(time.time()) + 3600,
            "iat": int(time.time()),
        }
        token = pyjwt.encode(payload, private_pem, algorithm="EdDSA")
        with pytest.raises(AuthError):
            verify_model_router_token(token, public_pem)

    def test_valid_token_with_owner_populates_claims(self, ed25519_keypair, make_jwt):
        """AI-1: Valid token with owner claim populates AgentClaims.owner."""
        _, public_pem = ed25519_keypair
        token = make_jwt(owner="user-uuid-123")
        claims = verify_model_router_token(token, public_pem)
        assert claims.owner == "user-uuid-123"

    def test_token_without_owner_sets_none(self, ed25519_keypair, make_jwt):
        """AI-2: Token without owner claim sets AgentClaims.owner to None."""
        _, public_pem = ed25519_keypair
        token = make_jwt()
        claims = verify_model_router_token(token, public_pem)
        assert claims.owner is None

    def test_rs256_keycloak_token_rejected(self, ed25519_keypair):
        """AB-4: RS256 Keycloak token rejected by model-router verifier."""
        import jwt as pyjwt
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            NoEncryption,
            PrivateFormat,
        )

        _, public_pem = ed25519_keypair

        # Generate an RSA key to simulate a Keycloak token
        rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        rsa_private_pem = rsa_key.private_bytes(
            Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
        )

        payload = {
            "sub": "human-user-id",
            "iss": "https://auth.hill90.com/realms/hill90",
            "aud": "hill90-model-router",
            "exp": int(time.time()) + 3600,
            "iat": int(time.time()),
            "jti": "keycloak-jti-001",
            "realm_roles": ["user", "admin"],
        }
        token = pyjwt.encode(
            payload, rsa_private_pem, algorithm="RS256", headers={"kid": "keycloak-kid-1"}
        )

        with pytest.raises(AuthError):
            verify_model_router_token(token, public_pem)
