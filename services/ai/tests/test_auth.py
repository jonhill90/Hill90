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
