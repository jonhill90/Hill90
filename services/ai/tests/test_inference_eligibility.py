"""Tests for _resolve_byok inference eligibility enforcement (AI-120).

Verifies that _resolve_byok enforces owner-scoped model resolution
without platform model fallback.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.auth import AgentClaims
from app.main import PolicyResult, _resolve_byok
from app.models import UserModelInfo


def _make_claims(sub: str = "test-agent-1", owner: str | None = None) -> AgentClaims:
    """Create AgentClaims for testing."""
    return AgentClaims(
        sub=sub,
        iss="hill90-api",
        aud="hill90-model-router",
        exp=9999999999,
        iat=1700000000,
        jti="test-jti-001",
        owner=owner,
    )


def _make_mock_get_db_conn(mock_conn):
    """Return a callable that produces a fresh async context manager each time.

    _resolve_byok calls get_db_conn() twice, so the factory must return
    a new context manager on each invocation.
    """

    @asynccontextmanager
    async def _db():
        yield mock_conn

    return _db


class TestResolveBYOK:
    """E5-E9: _resolve_byok eligibility enforcement."""

    @pytest.mark.asyncio
    async def test_e5_wrong_owner_raises_403(self):
        """E5: Agent owned by user-b, model exists for user-a only -> 403."""
        mock_conn = AsyncMock()

        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-b"),
            patch(
                "app.main.resolve_user_model", new_callable=AsyncMock, return_value=None
            ),
            patch("app.main.is_platform_model", new_callable=AsyncMock) as mock_is_platform,
        ):
            policy_result = PolicyResult(resolved_model="some-model")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "some-model"}

            with pytest.raises(HTTPException) as exc_info:
                await _resolve_byok(policy_result, claims, body)

            assert exc_info.value.status_code == 403
            assert "not found in user models for agent owner" in exc_info.value.detail
            mock_is_platform.assert_not_called()

    @pytest.mark.asyncio
    async def test_e6_correct_owner_byok_success(self):
        """E6: Agent owned by user-a, model exists -> BYOK key injection."""
        mock_conn = AsyncMock()
        user_model = UserModelInfo(
            litellm_model="openai/gpt-4o",
            api_key_encrypted=b"encrypted-data",
            api_key_nonce=b"nonce-data",
            api_base_url=None,
        )
        mock_settings = MagicMock()
        mock_settings.provider_key_encryption_key = "test-encryption-key"

        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-a"),
            patch(
                "app.main.resolve_user_model",
                new_callable=AsyncMock,
                return_value=user_model,
            ),
            patch("app.main.decrypt_provider_key", return_value="sk-test-key"),
            patch("app.main.get_settings", return_value=mock_settings),
        ):
            policy_result = PolicyResult(resolved_model="my-model")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "my-model"}

            result = await _resolve_byok(policy_result, claims, body)

            assert body["model"] == "openai/gpt-4o"
            assert body["api_key"] == "sk-test-key"
            assert result.user_model is not None
            assert result.owner == "user-a"

    @pytest.mark.asyncio
    async def test_e7_model_not_in_user_models_raises_403_no_platform_fallback(self):
        """E7: Model not in any user_models -> 403 (no platform fallback)."""
        mock_conn = AsyncMock()

        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-a"),
            patch(
                "app.main.resolve_user_model", new_callable=AsyncMock, return_value=None
            ),
            patch("app.main.is_platform_model", new_callable=AsyncMock) as mock_is_platform,
        ):
            policy_result = PolicyResult(resolved_model="unknown-model")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "unknown-model"}

            with pytest.raises(HTTPException) as exc_info:
                await _resolve_byok(policy_result, claims, body)

            assert exc_info.value.status_code == 403
            mock_is_platform.assert_not_called()

    @pytest.mark.asyncio
    async def test_e8_agent_not_found_raises_403(self):
        """E8: Agent not found (owner=None) -> 403 'Agent not found'."""
        mock_conn = AsyncMock()

        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value=None),
        ):
            policy_result = PolicyResult(resolved_model="some-model")
            claims = _make_claims(sub="ghost-agent")
            body = {"model": "some-model"}

            with pytest.raises(HTTPException) as exc_info:
                await _resolve_byok(policy_result, claims, body)

            assert exc_info.value.status_code == 403
            assert "Agent" in exc_info.value.detail
            assert "not found" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_e9_is_platform_model_never_called(self):
        """E9: is_platform_model is never called in either success or failure path."""
        mock_conn = AsyncMock()
        user_model = UserModelInfo(
            litellm_model="openai/gpt-4o",
            api_key_encrypted=b"encrypted-data",
            api_key_nonce=b"nonce-data",
            api_base_url=None,
        )
        mock_settings = MagicMock()
        mock_settings.provider_key_encryption_key = "test-encryption-key"

        # Success path
        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-a"),
            patch(
                "app.main.resolve_user_model",
                new_callable=AsyncMock,
                return_value=user_model,
            ),
            patch("app.main.decrypt_provider_key", return_value="sk-test-key"),
            patch("app.main.get_settings", return_value=mock_settings),
            patch("app.main.is_platform_model", new_callable=AsyncMock) as mock_is_platform,
        ):
            policy_result = PolicyResult(resolved_model="my-model")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "my-model"}
            await _resolve_byok(policy_result, claims, body)
            mock_is_platform.assert_not_called()

        # Failure path
        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-a"),
            patch(
                "app.main.resolve_user_model", new_callable=AsyncMock, return_value=None
            ),
            patch("app.main.is_platform_model", new_callable=AsyncMock) as mock_is_platform,
        ):
            policy_result = PolicyResult(resolved_model="missing-model")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "missing-model"}
            with pytest.raises(HTTPException):
                await _resolve_byok(policy_result, claims, body)
            mock_is_platform.assert_not_called()
