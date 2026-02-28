"""Async HTTP proxy to LiteLLM for chat completions, streaming, and embeddings.

Forwards OpenAI-compatible request bodies, parses token usage and cost
from the response, and returns enriched results.
"""

import json as json_mod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog

logger = structlog.get_logger()


def parse_usage(body: dict[str, Any]) -> tuple[int, int]:
    """Extract token counts from OpenAI-compatible response body.

    Returns (input_tokens, output_tokens). Defaults to (0, 0) if missing.
    """
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return 0, 0
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)
    if not isinstance(input_tokens, int):
        input_tokens = 0
    if not isinstance(output_tokens, int):
        output_tokens = 0
    return input_tokens, output_tokens


def parse_cost(headers: dict[str, str]) -> float:
    """Extract cost from LiteLLM x-litellm-response-cost header.

    Returns 0.0 if header is missing or unparseable.
    """
    raw = headers.get("x-litellm-response-cost", "0")
    try:
        cost = float(raw)
        return cost if cost >= 0 else 0.0
    except (ValueError, TypeError):
        logger.warning("cost_parse_failed", raw_value=raw)
        return 0.0


async def proxy_chat_completion(
    *,
    client: httpx.AsyncClient,
    litellm_url: str,
    litellm_master_key: str,
    request_body: dict[str, Any],
) -> dict[str, Any]:
    """Proxy a chat completion request to LiteLLM.

    Returns dict with 'status_code', 'body', 'headers',
    'input_tokens', 'output_tokens', and 'cost_usd'.
    """
    resp = await client.post(
        f"{litellm_url}/v1/chat/completions",
        json=request_body,
        headers={
            "Authorization": f"Bearer {litellm_master_key}",
            "Content-Type": "application/json",
        },
        timeout=120.0,
    )

    try:
        body = resp.json()
    except Exception:
        body = {"error": {"message": resp.text[:1000]}}

    resp_headers = dict(resp.headers)
    input_tokens, output_tokens = parse_usage(body)
    cost_usd = parse_cost(resp_headers)

    return {
        "status_code": resp.status_code,
        "body": body,
        "headers": resp_headers,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost_usd,
    }


# ---- Streaming proxy ----


@dataclass
class StreamingResult:
    """Captures usage data extracted from SSE stream."""

    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    completed: bool = False
    error: bool = False


def _parse_sse_events(buffer: str) -> tuple[list[str], str]:
    """Split buffer into complete SSE events and remaining incomplete data.

    Events are delimited by empty lines (\\n\\n or \\r\\n\\r\\n).
    Returns (list of complete event strings, remaining buffer).
    """
    # Normalise all SSE-valid line endings (\r\n, \r, \n) to \n
    normalised = buffer.replace("\r\n", "\n").replace("\r", "\n")
    # Split on double-newline (event boundary)
    parts = normalised.split("\n\n")
    # Last part is incomplete (no trailing \n\n yet)
    remainder = parts[-1]
    complete = [p for p in parts[:-1] if p.strip()]
    return complete, remainder


def _extract_usage_from_event(event_text: str) -> dict[str, Any] | None:
    """Parse a single SSE event and extract usage if present.

    Returns the usage dict if found, None otherwise.
    """
    data_lines: list[str] = []
    for line in event_text.split("\n"):
        if line.startswith(":"):
            continue  # comment / keepalive
        if line.startswith("data:"):
            # Strip "data:" prefix and optional single leading space (SSE spec)
            payload = line[5:]
            if payload.startswith(" "):
                payload = payload[1:]
            data_lines.append(payload)

    if not data_lines:
        return None

    joined = "\n".join(data_lines)
    if joined.strip() == "[DONE]":
        return None  # terminal sentinel, no JSON

    try:
        parsed = json_mod.loads(joined)
    except (json_mod.JSONDecodeError, ValueError):
        return None

    usage = parsed.get("usage")
    if isinstance(usage, dict) and usage:
        return usage
    return None


@dataclass
class StreamOpenResult:
    """Result of opening a streaming connection to LiteLLM.

    If `error_body` is not None, LiteLLM returned a non-2xx response before
    the stream started. The caller should return this body to the agent.
    """

    generator: AsyncIterator[bytes] | None = None
    streaming_result: StreamingResult | None = None
    status_code: int = 0
    error_body: dict[str, Any] | None = None


async def stream_chat_completion(
    *,
    client: httpx.AsyncClient,
    litellm_url: str,
    litellm_master_key: str,
    request_body: dict[str, Any],
) -> StreamOpenResult:
    """Open a streaming connection to LiteLLM and return a byte-chunk iterator.

    Injects stream_options.include_usage=true so the final SSE chunk
    contains token counts.

    Returns StreamOpenResult:
        - On success (2xx): generator + streaming_result populated, error_body=None
        - On non-2xx: error_body + status_code populated, generator=None

    Raises httpx.HTTPError on connection failure (network error, timeout).
    """
    # Inject stream_options to guarantee usage in final chunk
    body = dict(request_body)
    body["stream"] = True
    stream_opts = body.get("stream_options", {})
    if not isinstance(stream_opts, dict):
        stream_opts = {}
    stream_opts["include_usage"] = True
    body["stream_options"] = stream_opts

    result = StreamingResult()

    req = client.build_request(
        "POST",
        f"{litellm_url}/v1/chat/completions",
        json=body,
        headers={
            "Authorization": f"Bearer {litellm_master_key}",
            "Content-Type": "application/json",
        },
    )
    response = await client.send(req, stream=True)

    # Capture cost from initial response headers
    result.cost_usd = parse_cost(dict(response.headers))

    if response.status_code >= 400:
        # Non-2xx: read body, close, return error info for caller to pass through
        raw_body = await response.aread()
        await response.aclose()
        try:
            error_body = json_mod.loads(raw_body)
        except (json_mod.JSONDecodeError, ValueError):
            error_body = {"error": {"message": raw_body.decode("utf-8", errors="replace")[:1000]}}
        return StreamOpenResult(
            status_code=response.status_code,
            error_body=error_body,
        )

    async def _generate() -> AsyncIterator[bytes]:
        tee_buffer = ""
        try:
            async for chunk in response.aiter_raw():
                yield chunk
                # Tee into SSE parser
                try:
                    tee_buffer += chunk.decode("utf-8", errors="replace")
                except Exception:
                    continue
                events, tee_buffer = _parse_sse_events(tee_buffer)
                for event_text in events:
                    usage = _extract_usage_from_event(event_text)
                    if usage is not None:
                        result.input_tokens = usage.get("prompt_tokens", 0) or 0
                        result.output_tokens = usage.get("completion_tokens", 0) or 0
            result.completed = True
        except Exception as exc:
            result.error = True
            logger.warning("stream_error", error=str(exc))
            raise
        finally:
            await response.aclose()

    return StreamOpenResult(
        generator=_generate(),
        streaming_result=result,
        status_code=response.status_code,
    )


# ---- Embeddings proxy ----


async def proxy_embeddings(
    *,
    client: httpx.AsyncClient,
    litellm_url: str,
    litellm_master_key: str,
    request_body: dict[str, Any],
) -> dict[str, Any]:
    """Proxy an embeddings request to LiteLLM.

    Returns dict with 'status_code', 'body', 'input_tokens', and 'cost_usd'.
    Embeddings have no output tokens (always 0).
    """
    resp = await client.post(
        f"{litellm_url}/v1/embeddings",
        json=request_body,
        headers={
            "Authorization": f"Bearer {litellm_master_key}",
            "Content-Type": "application/json",
        },
        timeout=120.0,
    )

    try:
        body = resp.json()
    except Exception:
        body = {"error": {"message": resp.text[:1000]}}

    resp_headers = dict(resp.headers)
    input_tokens, _ = parse_usage(body)
    cost_usd = parse_cost(resp_headers)

    return {
        "status_code": resp.status_code,
        "body": body,
        "input_tokens": input_tokens,
        "output_tokens": 0,
        "cost_usd": cost_usd,
    }
