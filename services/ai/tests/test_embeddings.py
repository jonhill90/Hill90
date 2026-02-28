"""Tests for embeddings proxy."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.proxy import proxy_embeddings


class TestProxyEmbeddings:
    """Proxying embedding requests to LiteLLM."""

    @pytest.mark.asyncio
    async def test_proxy_embeddings_success(self):
        """Proxies embeddings request and parses usage."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "object": "list",
            "data": [{"embedding": [0.1, 0.2, 0.3], "index": 0, "object": "embedding"}],
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 8, "total_tokens": 8},
        }
        mock_response.headers = {
            "content-type": "application/json",
            "x-litellm-response-cost": "0.000001",
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_embeddings(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "text-embedding-3-small", "input": "hello"},
        )

        assert result["status_code"] == 200
        assert result["input_tokens"] == 8
        assert result["output_tokens"] == 0
        assert result["cost_usd"] == pytest.approx(0.000001)
        assert result["body"]["data"][0]["embedding"] == [0.1, 0.2, 0.3]

        # Verify correct URL
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args
        assert "/v1/embeddings" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_proxy_embeddings_error(self):
        """Passes through LiteLLM error responses for embeddings."""
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.json.return_value = {"error": {"message": "Invalid model"}}
        mock_response.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_embeddings(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "invalid-model", "input": "test"},
        )

        assert result["status_code"] == 400
        assert result["input_tokens"] == 0
        assert result["output_tokens"] == 0

    @pytest.mark.asyncio
    async def test_proxy_embeddings_missing_usage(self):
        """Returns zero tokens when embeddings response has no usage block."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "object": "list",
            "data": [{"embedding": [0.1], "index": 0}],
            "model": "text-embedding-3-small",
        }
        mock_response.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_embeddings(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "text-embedding-3-small", "input": "test"},
        )

        assert result["input_tokens"] == 0
        assert result["output_tokens"] == 0

    @pytest.mark.asyncio
    async def test_proxy_embeddings_no_completion_tokens(self):
        """Embeddings always return 0 output_tokens, even if response has completion_tokens."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "object": "list",
            "data": [{"embedding": [0.1], "index": 0}],
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 15, "completion_tokens": 0, "total_tokens": 15},
        }
        mock_response.headers = {"content-type": "application/json"}

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_embeddings(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "text-embedding-3-small", "input": "some text"},
        )

        assert result["input_tokens"] == 15
        assert result["output_tokens"] == 0

    @pytest.mark.asyncio
    async def test_proxy_embeddings_batch_input(self):
        """Handles batch embeddings (multiple inputs) in a single request."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "object": "list",
            "data": [
                {"embedding": [0.1, 0.2], "index": 0, "object": "embedding"},
                {"embedding": [0.3, 0.4], "index": 1, "object": "embedding"},
            ],
            "model": "text-embedding-3-small",
            "usage": {"prompt_tokens": 20, "total_tokens": 20},
        }
        mock_response.headers = {
            "content-type": "application/json",
            "x-litellm-response-cost": "0.000002",
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response

        result = await proxy_embeddings(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "text-embedding-3-small", "input": ["hello", "world"]},
        )

        assert result["status_code"] == 200
        assert result["input_tokens"] == 20
        assert result["output_tokens"] == 0
        assert len(result["body"]["data"]) == 2
