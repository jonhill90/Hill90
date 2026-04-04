"""Chat work handler — inference call + callback delivery.

Agentbox is the sole owner of system prompt assembly (§7.5).
API sends only structured data: messages array, model, callback info.
Agentbox reads identity from mounted files (SOUL.md + RULES.md with
baked-in skill instructions) and prepends the system prompt.
"""

from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING

import requests

if TYPE_CHECKING:
    from app.events import EventEmitter

logger = logging.getLogger(__name__)


def handle_chat(
    payload: dict,
    *,
    soul: str,
    rules: str,
    work_id: str,
    emitter: EventEmitter,
) -> None:
    """Handle a chat work item: build prompt, call AI, deliver callback.

    Args:
        payload: Work payload from API containing messages, model, callback_url,
                 thread_id, message_id.
        soul: Agent SOUL.md content.
        rules: Agent RULES.md content (includes skill instructions).
        work_id: Unique work execution ID for event correlation.
        emitter: Event emitter for observability.
    """
    thread_id = payload.get("thread_id", "unknown")
    message_id = payload.get("message_id", "unknown")
    model = payload.get("model", "gpt-4o-mini")
    callback_url = payload.get("callback_url")
    api_messages = payload.get("messages", [])

    chat_callback_token = os.environ.get("CHAT_CALLBACK_TOKEN")
    model_router_token = os.environ.get("MODEL_ROUTER_TOKEN")
    ai_service_url = os.environ.get("AI_SERVICE_URL", "http://ai:8000")

    # Validate required fields
    if not callback_url:
        emitter.emit(
            type="work_failed",
            tool="chat",
            input_summary=f"thread={thread_id} message={message_id}",
            output_summary="Missing callback_url in payload",
            duration_ms=0,
            success=False,
            metadata={"work_id": work_id},
        )
        return

    if not chat_callback_token:
        emitter.emit(
            type="work_failed",
            tool="chat",
            input_summary=f"thread={thread_id} message={message_id}",
            output_summary="CHAT_CALLBACK_TOKEN not configured",
            duration_ms=0,
            success=False,
            metadata={"work_id": work_id},
        )
        return

    if not model_router_token:
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="error", error_message="MODEL_ROUTER_TOKEN not configured",
            emitter=emitter, work_id=work_id,
        )
        return

    # Assemble system prompt (agentbox is sole owner — §7.5)
    system_content = ""
    if soul:
        system_content = soul
    if rules:
        system_content = f"{system_content}\n\n{rules}" if system_content else rules

    # Append group context if this is a group thread
    thread_type = payload.get("thread_type")
    participants = payload.get("participants")
    if thread_type == "group" and participants and isinstance(participants, list):
        agent_lines = "\n".join(
            f"- @{p['agent_id']}" for p in participants if isinstance(p, dict) and "agent_id" in p
        )
        if agent_lines:
            group_block = (
                "\n\n## Group Thread\n"
                "You are in a group conversation with these agents:\n"
                f"{agent_lines}\n"
                "Address other agents with @slug if you need their input."
            )
            system_content = f"{system_content}{group_block}" if system_content else group_block

    # Build final messages: system prompt + API-provided history
    final_messages = []
    if system_content:
        final_messages.append({"role": "system", "content": system_content})
    final_messages.extend(api_messages)

    emitter.emit(
        type="chat_inference_start",
        tool="chat",
        input_summary=f"thread={thread_id} model={model} messages={len(final_messages)}",
        output_summary=None,
        duration_ms=None,
        success=None,
        metadata={"work_id": work_id, "message_id": message_id},
    )

    # Call AI service
    start_time = time.monotonic()
    try:
        inference_url = f"{ai_service_url}/v1/chat/completions"
        resp = requests.post(
            inference_url,
            json={
                "model": model,
                "messages": final_messages,
            },
            headers={
                "Authorization": f"Bearer {model_router_token}",
                "Content-Type": "application/json",
            },
            timeout=120,
        )

        duration_ms = int((time.monotonic() - start_time) * 1000)

        if resp.status_code != 200:
            error_detail = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
            logger.error(
                "Chat inference failed: %s %s", resp.status_code, error_detail
            )
            _deliver_callback(
                callback_url, chat_callback_token, message_id,
                status="error",
                error_message=f"Inference failed: {error_detail}",
                duration_ms=duration_ms,
                emitter=emitter, work_id=work_id,
            )
            return

        result = resp.json()
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = result.get("usage", {})
        input_tokens = usage.get("prompt_tokens")
        output_tokens = usage.get("completion_tokens")
        response_model = result.get("model", model)

        emitter.emit(
            type="chat_inference_complete",
            tool="chat",
            input_summary=f"thread={thread_id} model={response_model}",
            output_summary=f"tokens_in={input_tokens} tokens_out={output_tokens}",
            duration_ms=duration_ms,
            success=True,
            metadata={"work_id": work_id, "message_id": message_id},
        )

        # Deliver callback with successful response
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="complete",
            content=content,
            model=response_model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            duration_ms=duration_ms,
            emitter=emitter, work_id=work_id,
        )

    except requests.Timeout:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        logger.error("Chat inference timed out after %dms", duration_ms)
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="error",
            error_message="Inference timed out",
            duration_ms=duration_ms,
            emitter=emitter, work_id=work_id,
        )

    except Exception as exc:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        logger.error("Chat inference error: %s", exc, exc_info=True)
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="error",
            error_message=f"Inference error: {str(exc)[:200]}",
            duration_ms=duration_ms,
            emitter=emitter, work_id=work_id,
        )


def _deliver_callback(
    callback_url: str,
    token: str,
    message_id: str,
    *,
    status: str,
    content: str = "",
    model: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    duration_ms: int | None = None,
    error_message: str | None = None,
    emitter: EventEmitter,
    work_id: str,
) -> None:
    """POST callback to API. Fire-and-forget — logs but does not retry."""
    body = {
        "message_id": message_id,
        "content": content,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "duration_ms": duration_ms,
        "status": status,
        "error_message": error_message,
    }

    try:
        resp = requests.post(
            callback_url,
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            timeout=10,
        )

        if resp.status_code != 200:
            logger.warning(
                "Callback returned %d for message %s: %s",
                resp.status_code, message_id, resp.text[:200],
            )

        emitter.emit(
            type="chat_callback_sent",
            tool="chat",
            input_summary=f"message={message_id} status={status}",
            output_summary=f"callback_status={resp.status_code}",
            duration_ms=None,
            success=resp.status_code == 200,
            metadata={"work_id": work_id, "message_id": message_id},
        )

    except Exception as exc:
        logger.error("Callback delivery failed for %s: %s", message_id, exc)
        emitter.emit(
            type="chat_callback_failed",
            tool="chat",
            input_summary=f"message={message_id} status={status}",
            output_summary=f"error={str(exc)[:100]}",
            duration_ms=None,
            success=False,
            metadata={"work_id": work_id, "message_id": message_id},
        )
