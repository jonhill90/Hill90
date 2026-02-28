"""Tests for internal endpoints: revocation, health, models list."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

# These imports will fail until implementation exists (Red phase)


class TestHealthEndpoint:
    """Health check endpoint."""

    @pytest.mark.asyncio
    async def test_health_endpoint(self):
        """GET /health returns 200 with healthy status."""
        from app.main import app

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"


class TestRevokeEndpoint:
    """Internal token revocation endpoint."""

    @pytest.mark.asyncio
    async def test_internal_revoke_persists_to_db(self):
        """POST /internal/revoke with valid service token persists JTI to DB."""
        from app.main import app
        from app.revocation import revocation_manager

        mock_conn = AsyncMock()
        mock_conn.execute.return_value = None

        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.get_db_conn", return_value=mock_ctx),
        ):
            mock_settings.return_value.model_router_internal_service_token = "test-service-token"

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/internal/revoke",
                    headers={"Authorization": "Bearer test-service-token"},
                    json={
                        "jti": "revoke-me-123",
                        "agent_id": "test-agent-1",
                        "expires_at": int(time.time()) + 3600,
                    },
                )

            assert resp.status_code == 200
            assert "revoke-me-123" in revocation_manager.revoked_jtis

    @pytest.mark.asyncio
    async def test_internal_revoke_rejects_bad_service_token(self):
        """POST /internal/revoke with wrong service token returns 403."""
        from app.main import app

        with patch("app.main.get_settings") as mock_settings:
            mock_settings.return_value.model_router_internal_service_token = "correct-token"

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/internal/revoke",
                    headers={"Authorization": "Bearer wrong-token"},
                    json={
                        "jti": "should-not-revoke",
                        "agent_id": "test-agent-1",
                        "expires_at": int(time.time()) + 3600,
                    },
                )

            assert resp.status_code == 403


class TestRevocationPersistence:
    """Revocation manager persistence across restarts."""

    @pytest.mark.asyncio
    async def test_revocation_preload_on_startup(self, mock_db_pool):
        """Preloads non-expired revoked JTIs from DB on init."""
        from app.revocation import RevocationManager

        pool, conn = mock_db_pool
        future_exp = int(time.time()) + 3600
        conn.fetch.return_value = [
            {"jti": "preloaded-jti-1", "expires_at": future_exp},
            {"jti": "preloaded-jti-2", "expires_at": future_exp},
        ]

        manager = RevocationManager()
        await manager.preload(conn)

        assert "preloaded-jti-1" in manager.revoked_jtis
        assert "preloaded-jti-2" in manager.revoked_jtis

    @pytest.mark.asyncio
    async def test_revoked_jti_survives_restart(self, mock_db_pool):
        """A JTI revoked before restart is still rejected after preload."""
        from app.revocation import RevocationManager

        pool, conn = mock_db_pool
        future_exp = int(time.time()) + 3600
        # Simulate DB contains a previously-revoked JTI
        conn.fetch.return_value = [
            {"jti": "survived-restart-jti", "expires_at": future_exp},
        ]

        manager = RevocationManager()
        await manager.preload(conn)

        assert "survived-restart-jti" in manager.revoked_jtis


class TestModelsEndpoint:
    """GET /v1/models endpoint."""

    @pytest.mark.asyncio
    async def test_models_endpoint_filters_by_db_policy(self, ed25519_keypair, make_jwt):
        """GET /v1/models returns only models allowed by agent's DB policy."""
        from app.main import app

        _, public_pem = ed25519_keypair
        token = make_jwt()

        with (
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn") as mock_get_conn,
            patch("app.main.revocation_manager") as mock_revocation,
        ):
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_revocation.revoked_jtis = set()

            mock_conn = AsyncMock()
            mock_conn.fetchrow.return_value = {
                "id": "policy-1",
                "name": "default",
                "allowed_models": ["gpt-4o-mini"],
            }
            mock_get_conn.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_get_conn.return_value.__aexit__ = AsyncMock(return_value=False)

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.get(
                    "/v1/models",
                    headers={"Authorization": f"Bearer {token}"},
                )

            assert resp.status_code == 200
            data = resp.json()
            model_ids = [m["id"] for m in data["data"]]
            assert "gpt-4o-mini" in model_ids
