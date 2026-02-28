"""Tests for chat completion proxy, DB policy lookup, and metadata-only logging."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from app.policy import resolve_model_policy
from app.proxy import proxy_chat_completion
from app.usage import log_request_metadata


class TestPolicyLookup:
    """Model authorization via DB policy lookup."""

    @pytest.mark.asyncio
    async def test_policy_lookup_from_db(self, mock_db_pool):
        """Resolves allowed models from agent's policy in DB."""
        pool, conn = mock_db_pool
        # Simulate: agent has model_policy_id -> policy row with allowed_models
        conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "default",
            "allowed_models": ["claude-sonnet-4-20250514", "gpt-4o-mini"],
        }
        result = await resolve_model_policy(conn, agent_id="test-agent-1")
        assert "claude-sonnet-4-20250514" in result
        assert "gpt-4o-mini" in result

    @pytest.mark.asyncio
    async def test_falls_back_to_default_policy(self, mock_db_pool):
        """Falls back to 'default' policy when agent has no policy assigned."""
        pool, conn = mock_db_pool
        # First call: agent has no model_policy_id
        conn.fetchrow.side_effect = [
            None,  # agent's direct policy lookup
            {  # fallback to default policy
                "id": "policy-default",
                "name": "default",
                "allowed_models": ["gpt-4o-mini"],
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
        }
        result = await resolve_model_policy(conn, agent_id="test-agent-1")
        assert "claude-sonnet-4-20250514" not in result
        assert "gpt-4o-mini" in result


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
        }
        mock_response.headers = {"content-type": "application/json"}

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


class TestUsageLogging:
    """Metadata-only audit logging."""

    @pytest.mark.asyncio
    async def test_logs_request_metadata_only(self, mock_db_pool):
        """Logs agent_id, model, status, latency — no token counts or cost."""
        pool, conn = mock_db_pool
        conn.execute.return_value = None

        await log_request_metadata(
            conn=conn,
            agent_id="test-agent-1",
            model_name="claude-sonnet-4-20250514",
            request_type="chat.completion",
            status="success",
            latency_ms=150,
        )

        conn.execute.assert_called_once()
        call_args = conn.execute.call_args
        sql = call_args[0][0]
        # Verify metadata columns are referenced
        assert "agent_id" in sql
        assert "model_name" in sql
        assert "status" in sql
        assert "latency_ms" in sql
        # Verify we do NOT set token/cost values
        params = call_args[0][1:]
        # Should have exactly: agent_id, model_name, request_type, status, latency_ms
        assert len(params) == 5 or (isinstance(params[0], tuple) and len(params[0]) == 5)
