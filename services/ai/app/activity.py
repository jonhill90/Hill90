"""Fire-and-forget inference event emission to the API service."""

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger()

MAX_SUMMARY_LEN = 200


async def emit_agent_event(
    agent_id: str,
    *,
    type: str,
    tool: str,
    input_summary: str,
    output_summary: str | None = None,
    duration_ms: int | None = None,
    success: bool | None = None,
    metadata: dict | None = None,
) -> None:
    """POST an inference event to the API internal endpoint. Never raises."""
    try:
        settings = get_settings()

        # Truncate input_summary
        if len(input_summary) > MAX_SUMMARY_LEN:
            input_summary = input_summary[:MAX_SUMMARY_LEN]

        body: dict = {
            "type": type,
            "tool": tool,
            "input_summary": input_summary,
        }
        if output_summary is not None:
            body["output_summary"] = output_summary
        if duration_ms is not None:
            body["duration_ms"] = duration_ms
        if success is not None:
            body["success"] = success
        if metadata is not None:
            body["metadata"] = metadata

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{settings.api_service_url}/internal/agents/{agent_id}/events",
                headers={
                    "Authorization": f"Bearer {settings.model_router_internal_service_token}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
    except Exception as e:
        logger.warning("emit_agent_event_failed", agent_id=agent_id, type=type, error=str(e))
