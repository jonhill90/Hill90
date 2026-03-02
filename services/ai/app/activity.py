"""Non-blocking inference event emission to the API service.

Events are dispatched as background tasks via asyncio.create_task().
The caller returns immediately — HTTP latency never affects inference.
"""

import asyncio

import httpx
import structlog

from app.config import get_settings

logger = structlog.get_logger()

MAX_SUMMARY_LEN = 200

# Hold references to background tasks so they aren't garbage-collected before completion.
_background_tasks: set[asyncio.Task] = set()


async def _do_emit(
    agent_id: str,
    body: dict,
) -> None:
    """Perform the actual HTTP POST. Runs as a background task. Never propagates exceptions."""
    try:
        settings = get_settings()
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
        logger.warning("emit_agent_event_failed", agent_id=agent_id, type=body.get("type"), error=str(e))


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
    """Fire-and-forget: schedules a background task and returns immediately.

    The HTTP POST runs concurrently. Failures are logged but never affect the caller.
    """
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

    task = asyncio.create_task(_do_emit(agent_id, body))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
