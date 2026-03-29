"""Tests for platform model fallback in _resolve_byok (AI-123).

Verifies that _resolve_byok resolves platform models as a fallback
when no user model or router model is found for the agent's owner.
Platform models are globally available (not owner-scoped) and use
platform-managed credentials.

Resolution order:
  1. User model (owner-scoped)
  2. Router model (owner-scoped)
  3. Platform model (global) -- NEW in AI-123
  4. 403 if none found
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

    _resolve_byok calls get_db_conn() multiple times, so the factory must return
    a new context manager on each invocation.
    """

    @asynccontextmanager
    async def _db():
        yield mock_conn

    return _db


class TestResolveBYOKPlatformFallback:
    """I1-I4: Platform model fallback in _resolve_byok (AI-123)."""

    @pytest.mark.asyncio
    async def test_i1_platform_model_resolves_when_no_user_model(self):
        """I1: No user model, no router model, platform model exists -> success with platform credentials."""
        mock_conn = AsyncMock()
        platform_model = UserModelInfo(
            litellm_model="gpt-4o",
            api_key_encrypted=b"platform-enc-data",
            api_key_nonce=b"platform-nonce",
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
                return_value=None,
            ),
            patch(
                "app.main.resolve_router_model",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.main.resolve_platform_model",
                new_callable=AsyncMock,
                return_value=platform_model,
            ),
            patch("app.main.decrypt_provider_key", return_value="sk-platform-test"),
            patch("app.main.get_settings", return_value=mock_settings),
        ):
            policy_result = PolicyResult(resolved_model="gpt-4o")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "gpt-4o"}

            result = await _resolve_byok(policy_result, claims, body)

            assert result.user_model is not None
            assert result.user_model.litellm_model == "gpt-4o"
            assert result.owner == "user-a"
            assert body["model"] == "gpt-4o"
            assert body["api_key"] == "sk-platform-test"

    @pytest.mark.asyncio
    async def test_i2_user_model_preferred_over_platform_model(self):
        """I2: User model exists -> user model wins, resolve_platform_model never called."""
        mock_conn = AsyncMock()
        user_model = UserModelInfo(
            litellm_model="openai/gpt-4o",
            api_key_encrypted=b"user-enc-data",
            api_key_nonce=b"user-nonce",
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
            patch("app.main.decrypt_provider_key", return_value="sk-user-key"),
            patch("app.main.get_settings", return_value=mock_settings),
            patch(
                "app.main.resolve_platform_model",
                new_callable=AsyncMock,
            ) as mock_resolve_platform,
        ):
            policy_result = PolicyResult(resolved_model="my-gpt4")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "my-gpt4"}

            result = await _resolve_byok(policy_result, claims, body)

            # User model should be selected
            assert result.user_model is not None
            assert result.user_model.litellm_model == "openai/gpt-4o"
            assert body["model"] == "openai/gpt-4o"
            assert body["api_key"] == "sk-user-key"
            # Platform model resolution should never be attempted
            mock_resolve_platform.assert_not_called()

    @pytest.mark.asyncio
    async def test_i3_403_when_no_user_router_or_platform_model(self):
        """I3: No user model, no router model, no platform model -> 403."""
        mock_conn = AsyncMock()

        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-a"),
            patch(
                "app.main.resolve_user_model",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.main.resolve_router_model",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.main.resolve_platform_model",
                new_callable=AsyncMock,
                return_value=None,
            ),
        ):
            policy_result = PolicyResult(resolved_model="nonexistent-model")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "nonexistent-model"}

            with pytest.raises(HTTPException) as exc_info:
                await _resolve_byok(policy_result, claims, body)

            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_i4_platform_model_credentials_decrypt_and_inject(self):
        """I4: Platform model credentials are decrypted and injected into body correctly."""
        mock_conn = AsyncMock()
        platform_model = UserModelInfo(
            litellm_model="anthropic/claude-sonnet-4-20250514",
            api_key_encrypted=b"\x01\x02\x03\x04\x05\x06\x07\x08",
            api_key_nonce=b"\x0a\x0b\x0c\x0d",
            api_base_url="https://custom.anthropic.example.com",
        )
        mock_settings = MagicMock()
        mock_settings.provider_key_encryption_key = "test-encryption-key"

        with (
            patch("app.main.get_db_conn", new=_make_mock_get_db_conn(mock_conn)),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-a"),
            patch(
                "app.main.resolve_user_model",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.main.resolve_router_model",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "app.main.resolve_platform_model",
                new_callable=AsyncMock,
                return_value=platform_model,
            ),
            patch("app.main.decrypt_provider_key", return_value="sk-platform-key-abc123"),
            patch("app.main.get_settings", return_value=mock_settings),
        ):
            policy_result = PolicyResult(resolved_model="claude-sonnet")
            claims = _make_claims(sub="test-agent-1")
            body = {"model": "claude-sonnet"}

            result = await _resolve_byok(policy_result, claims, body)

            # Model name swapped to litellm_model
            assert body["model"] == "anthropic/claude-sonnet-4-20250514"
            # API key decrypted and injected
            assert body["api_key"] == "sk-platform-key-abc123"
            # Custom base URL injected
            assert body["api_base"] == "https://custom.anthropic.example.com"
            # PolicyResult enriched
            assert result.user_model is not None
            assert result.user_model.litellm_model == "anthropic/claude-sonnet-4-20250514"
            assert result.provider_model_id == "anthropic/claude-sonnet-4-20250514"
            assert result.owner == "user-a"
