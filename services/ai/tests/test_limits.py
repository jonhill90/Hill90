"""Tests for rate limiting and token budget enforcement."""

from unittest.mock import AsyncMock

import pytest

from app.limits import check_rate_limit, check_token_budget


class TestRateLimit:
    """Per-agent requests-per-minute rate limiting."""

    @pytest.mark.asyncio
    async def test_allows_when_below_limit(self, mock_db_pool):
        """Allows request when count is below max_requests_per_minute."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"cnt": 3, "oldest_age_secs": 45}

        result = await check_rate_limit(conn, agent_id="agent-1", max_rpm=10)

        assert result.allowed is True
        assert result.count == 3
        assert result.limit == 10
        assert result.retry_after == 0

    @pytest.mark.asyncio
    async def test_denies_when_at_limit(self, mock_db_pool):
        """Denies request when count equals max_requests_per_minute."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"cnt": 10, "oldest_age_secs": 45}

        result = await check_rate_limit(conn, agent_id="agent-1", max_rpm=10)

        assert result.allowed is False
        assert result.count == 10
        assert result.retry_after == 15  # 60 - 45

    @pytest.mark.asyncio
    async def test_denies_when_above_limit(self, mock_db_pool):
        """Denies request when count exceeds max_requests_per_minute."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"cnt": 15, "oldest_age_secs": 50}

        result = await check_rate_limit(conn, agent_id="agent-1", max_rpm=10)

        assert result.allowed is False
        assert result.count == 15
        assert result.retry_after == 10  # 60 - 50

    @pytest.mark.asyncio
    async def test_query_filters_on_success_and_error_status(self, mock_db_pool):
        """Verifies the SQL query filters status IN ('success', 'error')."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"cnt": 0, "oldest_age_secs": None}

        await check_rate_limit(conn, agent_id="agent-1", max_rpm=10)

        sql = conn.fetchrow.call_args[0][0]
        assert "status IN ('success', 'error')" in sql

    @pytest.mark.asyncio
    async def test_handles_no_rows(self, mock_db_pool):
        """Allows request when no usage rows exist."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"cnt": 0, "oldest_age_secs": None}

        result = await check_rate_limit(conn, agent_id="new-agent", max_rpm=5)

        assert result.allowed is True
        assert result.count == 0


class TestTokenBudget:
    """Per-agent daily token budget enforcement."""

    @pytest.mark.asyncio
    async def test_allows_when_below_budget(self, mock_db_pool):
        """Allows request when tokens used is below max_tokens_per_day."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"total_tokens": 5000}

        result = await check_token_budget(conn, agent_id="agent-1", max_tokens=100000)

        assert result.allowed is True
        assert result.tokens_used == 5000
        assert result.limit == 100000

    @pytest.mark.asyncio
    async def test_denies_when_at_budget(self, mock_db_pool):
        """Denies request when tokens used equals max_tokens_per_day."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"total_tokens": 100000}

        result = await check_token_budget(conn, agent_id="agent-1", max_tokens=100000)

        assert result.allowed is False
        assert result.tokens_used == 100000

    @pytest.mark.asyncio
    async def test_denies_when_over_budget(self, mock_db_pool):
        """Denies request when tokens used exceeds max_tokens_per_day."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"total_tokens": 150000}

        result = await check_token_budget(conn, agent_id="agent-1", max_tokens=100000)

        assert result.allowed is False

    @pytest.mark.asyncio
    async def test_query_filters_on_success_and_error_status(self, mock_db_pool):
        """Verifies the SQL query filters status IN ('success', 'error')."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"total_tokens": 0}

        await check_token_budget(conn, agent_id="agent-1", max_tokens=100000)

        sql = conn.fetchrow.call_args[0][0]
        assert "status IN ('success', 'error')" in sql

    @pytest.mark.asyncio
    async def test_resets_at_is_utc_iso(self, mock_db_pool):
        """Resets_at is a valid ISO 8601 UTC timestamp for next midnight."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"total_tokens": 0}

        result = await check_token_budget(conn, agent_id="agent-1", max_tokens=100000)

        assert "T00:00:00" in result.resets_at
        assert result.resets_at.endswith("+00:00")

    @pytest.mark.asyncio
    async def test_handles_no_usage(self, mock_db_pool):
        """Allows request when no usage rows exist (COALESCE defaults to 0)."""
        _, conn = mock_db_pool
        conn.fetchrow.return_value = {"total_tokens": 0}

        result = await check_token_budget(conn, agent_id="new-agent", max_tokens=50000)

        assert result.allowed is True
        assert result.tokens_used == 0
