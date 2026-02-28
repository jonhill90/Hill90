"""Tests for chat completion proxy, DB policy lookup, usage logging, and parsing."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from app.policy import resolve_agent_policy, resolve_model_policy
from app.proxy import parse_cost, parse_usage, proxy_chat_completion
from app.usage import log_usage


class TestPolicyLookup:
    """Model authorization via DB policy lookup."""

    @pytest.mark.asyncio
    async def test_policy_lookup_from_db(self, mock_db_pool):
        """Resolves allowed models from agent's policy in DB."""
        pool, conn = mock_db_pool
        conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "default",
            "allowed_models": ["claude-sonnet-4-20250514", "gpt-4o-mini"],
            "max_requests_per_minute": None,
            "max_tokens_per_day": None,
        }
        result = await resolve_model_policy(conn, agent_id="test-agent-1")
        assert "claude-sonnet-4-20250514" in result
        assert "gpt-4o-mini" in result

    @pytest.mark.asyncio
    async def test_falls_back_to_default_policy(self, mock_db_pool):
        """Falls back to 'default' policy when agent has no policy assigned."""
        pool, conn = mock_db_pool
        conn.fetchrow.side_effect = [
            None,  # agent's direct policy lookup
            {  # fallback to default policy
                "id": "policy-default",
                "name": "default",
                "allowed_models": ["gpt-4o-mini"],
                "max_requests_per_minute": None,
                "max_tokens_per_day": None,
            },
        ]
        result = await resolve_model_policy(conn, agent_id="test-agent-no-policy")
        assert "gpt-4o-mini" in result

    @pytest.mark.asyncio
    async def test_denies_all_when_no_default_policy(self, mock_db_pool):
        """Returns empty list when no policy and no default exists (fail closed)."""
        pool, conn = mock_db_pool
        conn.fetchrow.return_value = None  # No policy found at all
        conn.fetchrow.side_effect = [None, None]
        result = await resolve_model_policy(conn, agent_id="test-agent-orphan")
        assert result == []

    @pytest.mark.asyncio
    async def test_rejects_unauthorized_model_via_policy(self, mock_db_pool):
        """Model not in agent's policy is rejected."""
        pool, conn = mock_db_pool
        conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "limited",
            "allowed_models": ["gpt-4o-mini"],
            "max_requests_per_minute": None,
            "max_tokens_per_day": None,
        }
        result = await resolve_model_policy(conn, agent_id="test-agent-1")
        assert "claude-sonnet-4-20250514" not in result
        assert "gpt-4o-mini" in result

    @pytest.mark.asyncio
    async def test_resolve_agent_policy_returns_limits(self, mock_db_pool):
        """resolve_agent_policy returns models and limits from DB."""
        pool, conn = mock_db_pool
        conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "limited",
            "allowed_models": ["gpt-4o-mini"],
            "max_requests_per_minute": 10,
            "max_tokens_per_day": 100000,
        }
        policy = await resolve_agent_policy(conn, agent_id="test-agent-1")
        assert policy.allowed_models == ["gpt-4o-mini"]
        assert policy.max_requests_per_minute == 10
        assert policy.max_tokens_per_day == 100000

    @pytest.mark.asyncio
    async def test_resolve_agent_policy_null_limits(self, mock_db_pool):
        """resolve_agent_policy returns None limits when not set."""
        pool, conn = mock_db_pool
        conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "default",
            "allowed_models": ["gpt-4o-mini"],
            "max_requests_per_minute": None,
            "max_tokens_per_day": None,
        }
        policy = await resolve_agent_policy(conn, agent_id="test-agent-1")
        assert policy.max_requests_per_minute is None
        assert policy.max_tokens_per_day is None


class TestProxyChatCompletion:
    """Proxying chat completions to LiteLLM."""

    @pytest.mark.asyncio
    async def test_proxy_chat_completion(self):
        """Proxies request to LiteLLM and returns OpenAI-compatible response."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "model": "claude-sonnet-4-20250514",
            "choices": [{"message": {"role": "assistant", "content": "Hello!"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        mock_response.headers = {
            "content-type": "application/json",
            "x-litellm-response-cost": "0.000325",
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        request_body = {
            "model": "claude-sonnet-4-20250514",
            "messages": [{"role": "user", "content": "Hi"}],
        }

        result = await proxy_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body=request_body,
        )

        assert result["status_code"] == 200
        assert result["body"]["choices"][0]["message"]["content"] == "Hello!"
        assert result["input_tokens"] == 10
        assert result["output_tokens"] == 5
        assert result["cost_usd"] == pytest.approx(0.000325)
        mock_client.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_proxy_returns_litellm_error(self):
        """Passes through LiteLLM error responses."""
        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_response.json.return_value = {"error": {"message": "Rate limit exceeded"}}
        mock_response.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o", "messages": []},
        )

        assert result["status_code"] == 429
        assert result["input_tokens"] == 0
        assert result["output_tokens"] == 0
        assert result["cost_usd"] == 0.0

    @pytest.mark.asyncio
    async def test_proxy_missing_usage_block(self):
        """Returns zero tokens when response has no usage block."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "id": "chatcmpl-test",
            "choices": [{"message": {"role": "assistant", "content": "Hi"}}],
        }
        mock_response.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        assert result["input_tokens"] == 0
        assert result["output_tokens"] == 0


class TestParseUsage:
    """Token count parsing from LiteLLM response body."""

    def test_parses_standard_usage(self):
        body = {"usage": {"prompt_tokens": 42, "completion_tokens": 18, "total_tokens": 60}}
        assert parse_usage(body) == (42, 18)

    def test_returns_zero_when_no_usage(self):
        assert parse_usage({}) == (0, 0)

    def test_returns_zero_when_usage_not_dict(self):
        assert parse_usage({"usage": "invalid"}) == (0, 0)

    def test_returns_zero_for_non_int_tokens(self):
        body = {"usage": {"prompt_tokens": "many", "completion_tokens": None}}
        assert parse_usage(body) == (0, 0)

    def test_handles_missing_fields(self):
        body = {"usage": {"prompt_tokens": 10}}
        assert parse_usage(body) == (10, 0)


class TestParseCost:
    """Cost parsing from LiteLLM response headers."""

    def test_parses_cost_header(self):
        assert parse_cost({"x-litellm-response-cost": "0.000325"}) == pytest.approx(0.000325)

    def test_returns_zero_when_missing(self):
        assert parse_cost({}) == 0.0

    def test_returns_zero_for_unparseable(self):
        assert parse_cost({"x-litellm-response-cost": "N/A"}) == 0.0

    def test_returns_zero_for_negative(self):
        assert parse_cost({"x-litellm-response-cost": "-0.5"}) == 0.0

    def test_returns_zero_for_zero_string(self):
        assert parse_cost({"x-litellm-response-cost": "0"}) == 0.0


class TestUsageLogging:
    """Usage logging with token counts and cost."""

    @pytest.mark.asyncio
    async def test_logs_usage_with_tokens_and_cost(self, mock_db_pool):
        """Logs agent_id, model, status, latency, tokens, and cost."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent-1",
            model_name="claude-sonnet-4-20250514",
            request_type="chat.completion",
            status="success",
            latency_ms=150,
            input_tokens=42,
            output_tokens=18,
            cost_usd=0.000325,
        )

        conn.execute.assert_called_once()
        call_args = conn.execute.call_args
        sql = call_args[0][0]
        assert "input_tokens" in sql
        assert "output_tokens" in sql
        assert "cost_usd" in sql
        # Params: agent_id, model_name, request_type, status, latency_ms,
        #         input_tokens, output_tokens, cost_usd, delegation_id
        params = call_args[0][1:]
        assert len(params) == 9

    @pytest.mark.asyncio
    async def test_logs_usage_defaults_to_zero(self, mock_db_pool):
        """Defaults token counts and cost to 0 when not provided."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_usage(
            conn=conn,
            agent_id="test-agent-1",
            model_name="gpt-4o-mini",
            request_type="chat.completion",
            status="error",
            latency_ms=50,
        )

        conn.execute.assert_called_once()
        call_args = conn.execute.call_args
        params = call_args[0][1:]
        # Last 3 params should be 0, 0, 0.0
        assert params[5] == 0  # input_tokens
        assert params[6] == 0  # output_tokens
        assert params[7] == 0.0  # cost_usd
