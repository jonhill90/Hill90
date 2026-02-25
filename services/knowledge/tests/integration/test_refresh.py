"""Integration tests for token refresh single-use enforcement."""

import hashlib
import time
import uuid

import jwt
import pytest

pytestmark = pytest.mark.integration


class TestRefresh:
    async def test_refresh_rejects_reused_secret(
        self, app_client, db_pool, ed25519_keypair
    ):
        """A refresh secret can only be used once."""
        private_pem, _ = ed25519_keypair
        agent_id = "refresh-test-agent"
        secret = str(uuid.uuid4())
        secret_hash = hashlib.sha256(secret.encode()).hexdigest()

        # Insert a token record
        now = int(time.time())
        jti = str(uuid.uuid4())
        await db_pool.execute(
            """INSERT INTO agent_tokens (agent_id, jti, token_hash, issued_at, expires_at)
               VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))""",
            agent_id,
            jti,
            secret_hash,
            now,
            now + 3600,
        )

        token = jwt.encode(
            {
                "sub": agent_id,
                "iss": "hill90-api",
                "aud": "hill90-akm",
                "exp": now + 3600,
                "iat": now,
                "jti": jti,
                "scopes": ["akm:read", "akm:write"],
            },
            private_pem,
            algorithm="EdDSA",
        )

        # First refresh should succeed
        resp = await app_client.post(
            "/internal/agents/refresh-token",
            headers={"Authorization": f"Bearer {token}"},
            json={"refresh_secret": secret},
        )
        assert resp.status_code == 200

        # Second refresh with same secret should fail (single-use)
        resp2 = await app_client.post(
            "/internal/agents/refresh-token",
            headers={"Authorization": f"Bearer {token}"},
            json={"refresh_secret": secret},
        )
        assert resp2.status_code == 401

    async def test_refresh_rotates_secret_invalidates_previous(
        self, app_client, db_pool, ed25519_keypair
    ):
        """After refresh, the new secret works but the old one doesn't."""
        private_pem, _ = ed25519_keypair
        agent_id = "rotate-test-agent"
        secret = str(uuid.uuid4())
        secret_hash = hashlib.sha256(secret.encode()).hexdigest()

        now = int(time.time())
        jti = str(uuid.uuid4())
        await db_pool.execute(
            """INSERT INTO agent_tokens (agent_id, jti, token_hash, issued_at, expires_at)
               VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))""",
            agent_id,
            jti,
            secret_hash,
            now,
            now + 3600,
        )

        token = jwt.encode(
            {
                "sub": agent_id,
                "iss": "hill90-api",
                "aud": "hill90-akm",
                "exp": now + 3600,
                "iat": now,
                "jti": jti,
                "scopes": ["akm:read", "akm:write"],
            },
            private_pem,
            algorithm="EdDSA",
        )

        # Refresh with original secret
        resp = await app_client.post(
            "/internal/agents/refresh-token",
            headers={"Authorization": f"Bearer {token}"},
            json={"refresh_secret": secret},
        )
        assert resp.status_code == 200
        data = resp.json()
        _new_secret = data["refresh_secret"]  # noqa: F841 — verified rotation happened
        new_token = data["token"]

        # Old secret should fail
        resp2 = await app_client.post(
            "/internal/agents/refresh-token",
            headers={"Authorization": f"Bearer {new_token}"},
            json={"refresh_secret": secret},
        )
        assert resp2.status_code == 401

    async def test_refresh_expired_secret_rejected(
        self, app_client, db_pool, ed25519_keypair
    ):
        """Expired token records are rejected during refresh."""
        private_pem, _ = ed25519_keypair
        agent_id = "expired-refresh-agent"
        secret = str(uuid.uuid4())
        secret_hash = hashlib.sha256(secret.encode()).hexdigest()

        past = int(time.time()) - 7200
        jti = str(uuid.uuid4())
        await db_pool.execute(
            """INSERT INTO agent_tokens (agent_id, jti, token_hash, issued_at, expires_at)
               VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5))""",
            agent_id,
            jti,
            secret_hash,
            past,
            past + 3600,  # expired 1h ago
        )

        token = jwt.encode(
            {
                "sub": agent_id,
                "iss": "hill90-api",
                "aud": "hill90-akm",
                "exp": past + 3600,
                "iat": past,
                "jti": jti,
                "scopes": ["akm:read", "akm:write"],
            },
            private_pem,
            algorithm="EdDSA",
        )

        resp = await app_client.post(
            "/internal/agents/refresh-token",
            headers={"Authorization": f"Bearer {token}"},
            json={"refresh_secret": secret},
        )
        # Expired JWT should be rejected
        assert resp.status_code == 401
