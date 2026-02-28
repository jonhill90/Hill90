"""Async HTTP proxy to LiteLLM for chat completions.

Forwards OpenAI-compatible request bodies and returns the response.
No token/cost parsing in Phase 1.
"""

from typing import Any

import httpx


async def proxy_chat_completion(
    *,
    client: httpx.AsyncClient,
    litellm_url: str,
    litellm_master_key: str,
    request_body: dict[str, Any],
) -> dict[str, Any]:
    """Proxy a chat completion request to LiteLLM.

    Returns dict with 'status_code', 'body', and 'headers'.
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

    return {
        "status_code": resp.status_code,
        "body": body,
        "headers": dict(resp.headers),
    }
