"""Tests for usage persistence with resolution chain columns (AI-121).

T1: log_usage with requested_model and provider_model_id persists both.
T2: log_usage with neither new param → NULLs (backward-compatible).
T3: log_usage with requested_model only (no provider_model_id).
"""

import pytest

from app.usage import log_usage


class TestUsagePersistence:
    """Verify log_usage persists requested_model and provider_model_id columns."""

    @pytest.mark.asyncio
    async def test_both_resolution_columns_persisted(self, mock_db_pool):
        """T1: log_usage with both new params persists both values."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="success",
            latency_ms=150,
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.001,
            delegation_id=None,
            owner="user-abc",
            requested_model="fast",
            provider_model_id="openai/gpt-4o-mini",
        )

        conn.execute.assert_called_once()
        call_args = conn.execute.call_args
        sql = call_args[0][0]

        # SQL should have 12 columns including both new ones
        assert "requested_model" in sql
        assert "provider_model_id" in sql

        # 12 positional params: agent_id, model_name, request_type, status,
        # latency_ms, input_tokens, output_tokens, cost_usd, delegation_id,
        # owner, requested_model, provider_model_id
        params = call_args[0][1:]
        assert len(params) == 12
        assert params[10] == "fast"  # requested_model
        assert params[11] == "openai/gpt-4o-mini"  # provider_model_id

    @pytest.mark.asyncio
    async def test_backward_compatible_nulls(self, mock_db_pool):
        """T2: log_usage without new params stores NULLs (backward-compatible)."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="success",
            latency_ms=150,
        )

        call_args = conn.execute.call_args
        params = call_args[0][1:]
        assert len(params) == 12
        assert params[10] is None  # requested_model defaults to None
        assert params[11] is None  # provider_model_id defaults to None

    @pytest.mark.asyncio
    async def test_requested_model_only(self, mock_db_pool):
        """T3: log_usage with requested_model only, provider_model_id is NULL."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="rate_limited",
            latency_ms=0,
            requested_model="fast",
        )

        call_args = conn.execute.call_args
        params = call_args[0][1:]
        assert params[10] == "fast"  # requested_model set
        assert params[11] is None   # provider_model_id is NULL
