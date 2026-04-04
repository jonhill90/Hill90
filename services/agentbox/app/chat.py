"""Chat work handler — inference call + tool-calling loop + callback delivery.

Agentbox is the sole owner of system prompt assembly (§7.5).
API sends only structured data: messages array, model, callback info.
Agentbox reads identity from mounted files (SOUL.md + RULES.md with
baked-in skill instructions) and prepends the system prompt.

When tools are enabled, the handler runs an iterative loop: call LLM,
execute any requested tool calls, feed results back, repeat until the
LLM produces a final text response or the iteration limit is reached.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import TYPE_CHECKING

import requests

from app.config import ToolLoopConfig, ToolsConfig
from app.tools import build_tool_definitions, execute_tool_call

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
    tools_config: ToolsConfig | None = None,
    tool_loop_config: ToolLoopConfig | None = None,
) -> None:
    """Handle a chat work item: build prompt, run tool loop, deliver callback."""
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
    final_messages: list[dict] = []
    if system_content:
        final_messages.append({"role": "system", "content": system_content})
    final_messages.extend(api_messages)

    # Build tool definitions from config
    tool_defs = build_tool_definitions(tools_config) if tools_config else []
    loop_config = tool_loop_config or ToolLoopConfig()

    # Run the tool-calling loop
    _run_tool_loop(
        messages=final_messages,
        tool_definitions=tool_defs,
        loop_config=loop_config,
        model=model,
        ai_service_url=ai_service_url,
        model_router_token=model_router_token,
        callback_url=callback_url,
        chat_callback_token=chat_callback_token,
        message_id=message_id,
        thread_id=thread_id,
        work_id=work_id,
        emitter=emitter,
    )


def _run_tool_loop(
    *,
    messages: list[dict],
    tool_definitions: list[dict],
    loop_config: ToolLoopConfig,
    model: str,
    ai_service_url: str,
    model_router_token: str,
    callback_url: str,
    chat_callback_token: str,
    message_id: str,
    thread_id: str,
    work_id: str,
    emitter: EventEmitter,
) -> None:
    """Iterative tool-calling loop. Calls LLM, executes tools, repeats."""
    inference_url = f"{ai_service_url}/v1/chat/completions"
    total_input_tokens = 0
    total_output_tokens = 0
    loop_start = time.monotonic()
    response_model = model
    content = ""

    for iteration in range(loop_config.max_iterations):
        # Check total timeout
        elapsed = time.monotonic() - loop_start
        if elapsed > loop_config.iteration_timeout:
            logger.warning("Tool loop timeout after %.1fs", elapsed)
            _deliver_callback(
                callback_url, chat_callback_token, message_id,
                status="error",
                error_message=f"Tool loop timed out after {int(elapsed)}s",
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                duration_ms=int(elapsed * 1000),
                emitter=emitter, work_id=work_id,
            )
            return

        emitter.emit(
            type="chat_inference_start",
            tool="chat",
            input_summary=f"thread={thread_id} model={model} iteration={iteration} messages={len(messages)}",
            output_summary=None,
            duration_ms=None,
            success=None,
            metadata={"work_id": work_id, "message_id": message_id},
        )

        # Build request body
        request_body: dict = {
            "model": model,
            "messages": messages,
        }
        if tool_definitions:
            request_body["tools"] = tool_definitions

        # Call LLM
        call_start = time.monotonic()
        try:
            resp = requests.post(
                inference_url,
                json=request_body,
                headers={
                    "Authorization": f"Bearer {model_router_token}",
                    "Content-Type": "application/json",
                },
                timeout=120,
            )
        except requests.Timeout:
            duration_ms = int((time.monotonic() - loop_start) * 1000)
            logger.error("Chat inference timed out on iteration %d", iteration)
            _deliver_callback(
                callback_url, chat_callback_token, message_id,
                status="error",
                error_message="Inference timed out",
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                duration_ms=duration_ms,
                emitter=emitter, work_id=work_id,
            )
            return
        except Exception as exc:
            duration_ms = int((time.monotonic() - loop_start) * 1000)
            logger.error("Chat inference error on iteration %d: %s", iteration, exc, exc_info=True)
            _deliver_callback(
                callback_url, chat_callback_token, message_id,
                status="error",
                error_message=f"Inference error: {str(exc)[:200]}",
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                duration_ms=duration_ms,
                emitter=emitter, work_id=work_id,
            )
            return

        call_duration = int((time.monotonic() - call_start) * 1000)

        if resp.status_code != 200:
            error_detail = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
            logger.error("Chat inference failed: %s %s", resp.status_code, error_detail)
            _deliver_callback(
                callback_url, chat_callback_token, message_id,
                status="error",
                error_message=f"Inference failed: {error_detail}",
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                duration_ms=int((time.monotonic() - loop_start) * 1000),
                emitter=emitter, work_id=work_id,
            )
            return

        result = resp.json()
        choice = result.get("choices", [{}])[0]
        message = choice.get("message", {})
        content = message.get("content", "") or ""
        tool_calls = message.get("tool_calls")
        finish_reason = choice.get("finish_reason", "stop")
        response_model = result.get("model", model)

        # Accumulate tokens
        usage = result.get("usage", {})
        total_input_tokens += usage.get("prompt_tokens", 0)
        total_output_tokens += usage.get("completion_tokens", 0)

        emitter.emit(
            type="chat_inference_complete",
            tool="chat",
            input_summary=f"thread={thread_id} model={response_model} iteration={iteration}",
            output_summary=f"tokens_in={usage.get('prompt_tokens')} tokens_out={usage.get('completion_tokens')} finish={finish_reason}",
            duration_ms=call_duration,
            success=True,
            metadata={"work_id": work_id, "message_id": message_id},
        )

        # If no tool calls, this is the final response
        if not tool_calls or finish_reason != "tool_calls":
            total_duration = int((time.monotonic() - loop_start) * 1000)
            _deliver_callback(
                callback_url, chat_callback_token, message_id,
                status="complete",
                content=content,
                model=response_model,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                duration_ms=total_duration,
                emitter=emitter, work_id=work_id,
            )
            return

        # Append the assistant message with tool_calls to the conversation
        assistant_msg: dict = {"role": "assistant"}
        if content:
            assistant_msg["content"] = content
        assistant_msg["tool_calls"] = tool_calls
        messages.append(assistant_msg)

        # Execute each tool call and append results
        for tc in tool_calls:
            tc_id = tc.get("id", "")
            func = tc.get("function", {})
            func_name = func.get("name", "")
            func_args_raw = func.get("arguments", "{}")

            # Parse arguments
            try:
                func_args = json.loads(func_args_raw) if isinstance(func_args_raw, str) else func_args_raw
            except json.JSONDecodeError:
                func_args = {}
                logger.warning("Failed to parse tool call arguments for %s: %s", func_name, func_args_raw[:200])

            emitter.emit(
                type="tool_call_start",
                tool="chat",
                input_summary=f"tool={func_name} args={str(func_args)[:150]}",
                output_summary=None,
                duration_ms=None,
                success=None,
                metadata={"work_id": work_id, "tool_call_id": tc_id},
            )

            tool_start = time.monotonic()
            try:
                tool_result = asyncio.run(
                    execute_tool_call(func_name, func_args, work_id=work_id, emitter=emitter)
                )
            except Exception as exc:
                tool_result = json.dumps({"success": False, "error": str(exc)[:500]})
                logger.error("Tool call %s failed: %s", func_name, exc, exc_info=True)

            tool_duration = int((time.monotonic() - tool_start) * 1000)

            emitter.emit(
                type="tool_call_complete",
                tool="chat",
                input_summary=f"tool={func_name}",
                output_summary=f"duration={tool_duration}ms result_len={len(tool_result)}",
                duration_ms=tool_duration,
                success=True,
                metadata={"work_id": work_id, "tool_call_id": tc_id},
            )

            # Append tool result message
            messages.append({
                "role": "tool",
                "tool_call_id": tc_id,
                "content": tool_result,
            })

        # Send thinking progress callback
        tools_summary = ", ".join(
            tc.get("function", {}).get("name", "?") for tc in tool_calls
        )
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="thinking",
            content=f"Executed: {tools_summary}",
            model=response_model,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            duration_ms=int((time.monotonic() - loop_start) * 1000),
            emitter=emitter, work_id=work_id,
        )

    # Exhausted iterations — deliver whatever content we have
    logger.warning("Tool loop exhausted %d iterations", loop_config.max_iterations)
    total_duration = int((time.monotonic() - loop_start) * 1000)
    _deliver_callback(
        callback_url, chat_callback_token, message_id,
        status="complete",
        content=content or "I reached my tool execution limit. Here's what I found so far.",
        model=response_model,
        input_tokens=total_input_tokens,
        output_tokens=total_output_tokens,
        duration_ms=total_duration,
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
