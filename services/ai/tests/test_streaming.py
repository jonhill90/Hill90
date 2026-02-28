"""Tests for streaming chat completion proxy and SSE event parsing."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.proxy import (
    StreamOpenResult,
    StreamingResult,
    _extract_usage_from_event,
    _parse_sse_events,
    stream_chat_completion,
)


class TestParseSSEEvents:
    """SSE event boundary detection and splitting."""

    def test_splits_on_double_newline(self):
        buffer = 'data: {"id":"1"}\n\ndata: {"id":"2"}\n\n'
        events, remainder = _parse_sse_events(buffer)
        assert len(events) == 2
        assert remainder == ""

    def test_preserves_incomplete_trailing_data(self):
        buffer = 'data: {"id":"1"}\n\ndata: {"id":"2"}\ndata: partial'
        events, remainder = _parse_sse_events(buffer)
        assert len(events) == 1
        assert "partial" in remainder

    def test_handles_crlf_line_endings(self):
        buffer = 'data: {"id":"1"}\r\n\r\ndata: {"id":"2"}\r\n\r\n'
        events, remainder = _parse_sse_events(buffer)
        assert len(events) == 2

    def test_empty_buffer_returns_empty(self):
        events, remainder = _parse_sse_events("")
        assert events == []
        assert remainder == ""

    def test_no_complete_events(self):
        buffer = 'data: {"id":"1"}\ndata: still going'
        events, remainder = _parse_sse_events(buffer)
        assert events == []
        assert "still going" in remainder

    def test_skips_empty_events(self):
        buffer = '\n\ndata: {"id":"1"}\n\n'
        events, remainder = _parse_sse_events(buffer)
        assert len(events) == 1

    def test_handles_bare_cr_line_endings(self):
        buffer = 'data: {"id":"1"}\r\rdata: {"id":"2"}\r\r'
        events, remainder = _parse_sse_events(buffer)
        assert len(events) == 2


class TestExtractUsageFromEvent:
    """Usage extraction from individual SSE events."""

    def test_extracts_usage_from_final_chunk(self):
        event = 'data: {"id":"cmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
        usage = _extract_usage_from_event(event)
        assert usage is not None
        assert usage["prompt_tokens"] == 10
        assert usage["completion_tokens"] == 5

    def test_returns_none_for_content_chunk(self):
        event = 'data: {"id":"cmpl-1","choices":[{"delta":{"content":"Hello"}}],"usage":null}'
        usage = _extract_usage_from_event(event)
        assert usage is None

    def test_returns_none_for_done_sentinel(self):
        event = "data: [DONE]"
        usage = _extract_usage_from_event(event)
        assert usage is None

    def test_skips_comment_lines(self):
        event = ": keepalive\ndata: [DONE]"
        usage = _extract_usage_from_event(event)
        assert usage is None

    def test_handles_multiple_data_lines(self):
        event = 'data: {"id":"cmpl-1","usage":\ndata: {"prompt_tokens":10,"completion_tokens":5}}'
        # Multiple data: lines joined with \n per SSE spec
        usage = _extract_usage_from_event(event)
        # JSON parse of joined lines: '{"id":"cmpl-1","usage":\n{"prompt_tokens":10,"completion_tokens":5}}'
        # Newline is valid JSON whitespace, so this parses successfully
        assert usage is not None
        assert usage["prompt_tokens"] == 10
        assert usage["completion_tokens"] == 5

    def test_returns_none_for_invalid_json(self):
        event = "data: {not valid json}"
        usage = _extract_usage_from_event(event)
        assert usage is None

    def test_returns_none_for_empty_usage(self):
        event = 'data: {"id":"cmpl-1","choices":[],"usage":{}}'
        usage = _extract_usage_from_event(event)
        assert usage is None

    def test_strips_optional_space_after_data_colon(self):
        event = 'data:{"id":"cmpl-1","usage":{"prompt_tokens":10,"completion_tokens":5}}'
        usage = _extract_usage_from_event(event)
        assert usage is not None
        assert usage["prompt_tokens"] == 10

    def test_no_data_lines(self):
        event = ": just a comment"
        usage = _extract_usage_from_event(event)
        assert usage is None


class TestStreamChatCompletion:
    """Streaming proxy to LiteLLM."""

    @pytest.mark.asyncio
    async def test_injects_stream_options(self):
        """Verifies stream_options.include_usage=true is injected."""
        captured_body = {}

        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "text/event-stream"}

        async def fake_aiter_raw():
            yield b'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}],"usage":null}\n\n'
            yield b'data: {"id":"1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'
            yield b"data: [DONE]\n\n"

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()

        def capture_build(method, url, *, json, headers):
            captured_body.update(json)
            req = MagicMock()
            return req

        mock_client.build_request = capture_build
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}]},
        )

        # Consume the generator
        async for _ in open_result.generator:
            pass

        assert captured_body["stream"] is True
        assert captured_body["stream_options"]["include_usage"] is True

    @pytest.mark.asyncio
    async def test_extracts_usage_from_final_chunk(self):
        """Captures token counts from the final SSE usage chunk."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {"x-litellm-response-cost": "0.001"}

        async def fake_aiter_raw():
            yield b'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}],"usage":null}\n\n'
            yield b'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
            yield b"data: [DONE]\n\n"

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        async for _ in open_result.generator:
            pass

        result = open_result.streaming_result
        assert result.input_tokens == 10
        assert result.output_tokens == 5
        assert result.cost_usd == pytest.approx(0.001)
        assert result.completed is True

    @pytest.mark.asyncio
    async def test_raw_bytes_pass_through_unmodified(self):
        """Verifies raw SSE bytes are forwarded without modification."""
        chunk1 = b'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}],"usage":null}\n\n'
        chunk2 = b"data: [DONE]\n\n"

        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {}

        async def fake_aiter_raw():
            yield chunk1
            yield chunk2

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        received = []
        async for chunk in open_result.generator:
            received.append(chunk)

        assert received == [chunk1, chunk2]

    @pytest.mark.asyncio
    async def test_non_2xx_returns_error_body(self):
        """Non-2xx from LiteLLM returns error_body in StreamOpenResult."""
        mock_response = AsyncMock()
        mock_response.status_code = 429
        mock_response.headers = {}
        mock_response.aread = AsyncMock(return_value=b'{"error":{"message":"Rate limit exceeded"}}')
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        assert open_result.status_code == 429
        assert open_result.error_body is not None
        assert open_result.error_body["error"]["message"] == "Rate limit exceeded"
        assert open_result.generator is None
        assert open_result.streaming_result is None

    @pytest.mark.asyncio
    async def test_non_2xx_with_non_json_body(self):
        """Non-2xx with non-JSON body wraps raw text in error dict."""
        mock_response = AsyncMock()
        mock_response.status_code = 503
        mock_response.headers = {}
        mock_response.aread = AsyncMock(return_value=b"Service Unavailable")
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        assert open_result.status_code == 503
        assert open_result.error_body is not None
        assert "Service Unavailable" in open_result.error_body["error"]["message"]

    @pytest.mark.asyncio
    async def test_upstream_error_sets_error_flag(self):
        """Upstream error mid-stream sets streaming_result.error."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {}

        async def failing_aiter_raw():
            yield b'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}],"usage":null}\n\n'
            raise httpx.ReadError("connection reset")

        mock_response.aiter_raw = failing_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        with pytest.raises(httpx.ReadError):
            async for _ in open_result.generator:
                pass

        assert open_result.streaming_result.error is True
        assert open_result.streaming_result.completed is False

    @pytest.mark.asyncio
    async def test_closes_upstream_on_completion(self):
        """Upstream httpx response is closed after stream completes."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {}

        async def fake_aiter_raw():
            yield b"data: [DONE]\n\n"

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        async for _ in open_result.generator:
            pass

        mock_response.aclose.assert_called_once()

    @pytest.mark.asyncio
    async def test_preserves_existing_stream_options(self):
        """Does not overwrite other stream_options the client sent."""
        captured_body = {}

        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {}

        async def fake_aiter_raw():
            yield b"data: [DONE]\n\n"

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()

        def capture_build(method, url, *, json, headers):
            captured_body.update(json)
            return MagicMock()

        mock_client.build_request = capture_build
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={
                "model": "gpt-4o-mini",
                "messages": [],
                "stream_options": {"some_other_option": True},
            },
        )

        async for _ in open_result.generator:
            pass

        assert captured_body["stream_options"]["include_usage"] is True
        assert captured_body["stream_options"]["some_other_option"] is True

    @pytest.mark.asyncio
    async def test_usage_chunk_split_across_raw_chunks(self):
        """Handles usage data split across multiple raw byte chunks."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {}

        # Usage event split across two raw chunks
        part1 = b'data: {"id":"1","choices":[],"usage":{"prompt_to'
        part2 = b'kens":20,"completion_tokens":10,"total_tokens":30}}\n\n'
        part3 = b"data: [DONE]\n\n"

        async def fake_aiter_raw():
            yield part1
            yield part2
            yield part3

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        async for _ in open_result.generator:
            pass

        assert open_result.streaming_result.input_tokens == 20
        assert open_result.streaming_result.output_tokens == 10
        assert open_result.streaming_result.completed is True

    @pytest.mark.asyncio
    async def test_2xx_result_has_generator_and_streaming_result(self):
        """Successful open returns generator, streaming_result, and no error_body."""
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {}

        async def fake_aiter_raw():
            yield b"data: [DONE]\n\n"

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_client = AsyncMock()
        mock_client.build_request = MagicMock(return_value=MagicMock())
        mock_client.send = AsyncMock(return_value=mock_response)

        open_result = await stream_chat_completion(
            client=mock_client,
            litellm_url="http://litellm:4000",
            litellm_master_key="test-key",
            request_body={"model": "gpt-4o-mini", "messages": []},
        )

        assert open_result.generator is not None
        assert open_result.streaming_result is not None
        assert open_result.error_body is None
        assert open_result.status_code == 200

        async for _ in open_result.generator:
            pass
