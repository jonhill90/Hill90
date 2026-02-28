"""Async HTTP proxy to LiteLLM for chat completions.

Forwards OpenAI-compatible request bodies, parses token usage and cost
from the response, and returns enriched results.
"""

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
