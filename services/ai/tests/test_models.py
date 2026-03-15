"""Tests for BYOK model resolution — user-owned models and platform catalog."""

import time
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio

from app.models import (
    UserModelInfo,
    clear_owner_cache,
    get_agent_owner,
    is_platform_model,
    resolve_user_model,
)


@pytest.fixture(autouse=True)
def clear_cache():
    """Clear the agent owner cache before each test."""
    clear_owner_cache()
    yield
    clear_owner_cache()


@pytest.fixture
def mock_conn():
    """Create a mock asyncpg connection."""
    conn = AsyncMock()
    return conn


class TestGetAgentOwner:
    """Agent owner lookup with caching."""

    @pytest.mark.asyncio
    async def test_returns_owner(self, mock_conn):
        mock_conn.fetchrow.return_value = {"created_by": "user-a"}

        owner = await get_agent_owner(mock_conn, "agent-1")

        assert owner == "user-a"
        mock_conn.fetchrow.assert_called_once_with(
            "SELECT created_by FROM agents WHERE agent_id = $1", "agent-1"
        )

    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_agent(self, mock_conn):
        mock_conn.fetchrow.return_value = None

        owner = await get_agent_owner(mock_conn, "nonexistent")

        assert owner is None

    @pytest.mark.asyncio
    async def test_caches_result(self, mock_conn):
        mock_conn.fetchrow.return_value = {"created_by": "user-a"}

        owner1 = await get_agent_owner(mock_conn, "agent-1")
        owner2 = await get_agent_owner(mock_conn, "agent-1")

        assert owner1 == "user-a"
        assert owner2 == "user-a"
        # Should only have queried once (second call hit cache)
        assert mock_conn.fetchrow.call_count == 1

    @pytest.mark.asyncio
    async def test_different_agents_cached_separately(self, mock_conn):
        mock_conn.fetchrow.side_effect = [
            {"created_by": "user-a"},
            {"created_by": "user-b"},
        ]

        owner_a = await get_agent_owner(mock_conn, "agent-1")
        owner_b = await get_agent_owner(mock_conn, "agent-2")

        assert owner_a == "user-a"
        assert owner_b == "user-b"
        assert mock_conn.fetchrow.call_count == 2


class TestResolveUserModel:
    """User model resolution with connection details."""

    @pytest.mark.asyncio
    async def test_resolves_user_model(self, mock_conn):
        mock_conn.fetchrow.return_value = {
            "litellm_model": "openai/gpt-4o",
            "api_key_encrypted": b"encrypted-data",
            "api_key_nonce": b"nonce-data",
            "api_base_url": None,
        }

        result = await resolve_user_model(mock_conn, "my-gpt4", "user-a")

        assert result is not None
        assert result.litellm_model == "openai/gpt-4o"
        assert result.api_key_encrypted == b"encrypted-data"
        assert result.api_key_nonce == b"nonce-data"
        assert result.api_base_url is None

        # Verify the SQL joins user_models with provider_connections
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "user_models" in sql
        assert "provider_connections" in sql
        assert "is_active = true" in sql

    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_model(self, mock_conn):
        mock_conn.fetchrow.return_value = None

        result = await resolve_user_model(mock_conn, "unknown-model", "user-a")

        assert result is None

    @pytest.mark.asyncio
    async def test_scopes_to_owner(self, mock_conn):
        mock_conn.fetchrow.return_value = None

        await resolve_user_model(mock_conn, "my-model", "user-a")

        sql = mock_conn.fetchrow.call_args[0][0]
        assert "created_by = $2" in sql
        args = mock_conn.fetchrow.call_args[0][1:]
        assert args == ("my-model", "user-a")

    @pytest.mark.asyncio
    async def test_includes_api_base_url(self, mock_conn):
        mock_conn.fetchrow.return_value = {
            "litellm_model": "openai/gpt-4o",
            "api_key_encrypted": b"encrypted",
            "api_key_nonce": b"nonce",
            "api_base_url": "https://custom.openai.azure.com",
        }

        result = await resolve_user_model(mock_conn, "azure-gpt4", "user-a")

        assert result is not None
        assert result.api_base_url == "https://custom.openai.azure.com"


class TestIsPlatformModel:
    """Platform model catalog check."""

    @pytest.mark.asyncio
    async def test_active_platform_model(self, mock_conn):
        mock_conn.fetchval.return_value = 1

        assert await is_platform_model(mock_conn, "gpt-4o-mini") is True

        sql = mock_conn.fetchval.call_args[0][0]
        assert "model_catalog" in sql
        assert "is_active = true" in sql

    @pytest.mark.asyncio
    async def test_inactive_platform_model_rejected(self, mock_conn):
        mock_conn.fetchval.return_value = None

        assert await is_platform_model(mock_conn, "old-model") is False

    @pytest.mark.asyncio
    async def test_unknown_model_returns_false(self, mock_conn):
        mock_conn.fetchval.return_value = None

        assert await is_platform_model(mock_conn, "nonexistent") is False


class TestUsageOwner:
    """Usage logging includes owner field."""

    @pytest.mark.asyncio
    async def test_usage_log_stamps_owner(self, mock_conn):
        """Verify log_usage accepts and passes the owner parameter."""
        from app.usage import log_usage

        mock_conn.execute.return_value = None

        await log_usage(
            conn=mock_conn,
            agent_id="agent-1",
            model_name="my-gpt4",
            request_type="chat.completion",
            status="success",
            latency_ms=100,
            input_tokens=10,
            output_tokens=5,
            cost_usd=0.001,
            owner="user-a",
        )

        mock_conn.execute.assert_called_once()
        sql = mock_conn.execute.call_args[0][0]
        assert "owner" in sql
        # owner is param 10 (index 9)
        params = mock_conn.execute.call_args[0][1:]
        assert params[9] == "user-a"

    @pytest.mark.asyncio
    async def test_usage_log_owner_defaults_to_none(self, mock_conn):
        """Without owner parameter, it should default to None."""
        from app.usage import log_usage

        mock_conn.execute.return_value = None

        await log_usage(
            conn=mock_conn,
            agent_id="agent-1",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="success",
            latency_ms=50,
        )

        params = mock_conn.execute.call_args[0][1:]
        assert params[-1] is None  # owner defaults to None


class TestResolveUserModelOwnerScoping:
    """E1-E4: Eligibility enforcement — owner-scoped model resolution."""

    @pytest.mark.asyncio
    async def test_e1_wrong_owner_returns_none(self, mock_conn):
        """E1: Model owned by user-a, queried as user-b returns None."""
        mock_conn.fetchrow.return_value = None

        result = await resolve_user_model(mock_conn, "user-a-model", "user-b")

        assert result is None
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "created_by = $2" in sql
        args = mock_conn.fetchrow.call_args[0][1:]
        assert "user-b" in args

    @pytest.mark.asyncio
    async def test_e2_correct_owner_returns_model(self, mock_conn):
        """E2: Model owned by user-a, queried as user-a returns UserModelInfo."""
        mock_conn.fetchrow.return_value = {
            "litellm_model": "openai/gpt-4o",
            "api_key_encrypted": b"enc-key",
            "api_key_nonce": b"nonce",
            "api_base_url": None,
        }

        result = await resolve_user_model(mock_conn, "user-a-model", "user-a")

        assert result is not None
        assert result.litellm_model == "openai/gpt-4o"
        args = mock_conn.fetchrow.call_args[0][1:]
        assert "user-a" in args

    @pytest.mark.asyncio
    async def test_e3_inactive_model_returns_none(self, mock_conn):
        """E3: Correct owner but is_active=false returns None."""
        mock_conn.fetchrow.return_value = None

        result = await resolve_user_model(mock_conn, "inactive-model", "user-a")

        assert result is None
        sql = mock_conn.fetchrow.call_args[0][0]
        assert "is_active = true" in sql

    @pytest.mark.asyncio
    async def test_e4_sql_joins_provider_connections(self, mock_conn):
        """E4: SQL query JOINs provider_connections table."""
        mock_conn.fetchrow.return_value = None

        await resolve_user_model(mock_conn, "test-model", "user-a")

        sql = mock_conn.fetchrow.call_args[0][0]
        assert "JOIN provider_connections" in sql
