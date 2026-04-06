"""Chat work handler — dispatches tasks to the visible tmux terminal.

Agentbox is the sole owner of system prompt assembly (§7.5).
API sends only structured data: messages array, model, callback info.
Agentbox reads identity from mounted files (SOUL.md + RULES.md with
baked-in skill instructions) and prepends the system prompt.

Terminal dispatch (AI-181): classifies user messages as either direct
shell commands or complex tasks. Direct commands run in tmux via
send-keys. Complex tasks use Claude Code CLI (if available) or the
legacy tool-use loop. ALL execution is visible in xterm.js.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from typing import TYPE_CHECKING

import requests

from app.config import ToolLoopConfig, ToolsConfig
from app.tools import build_tool_definitions, execute_tool_call

if TYPE_CHECKING:
    from app.events import EventEmitter

logger = logging.getLogger(__name__)

TMUX_SESSION = "agent"


def handle_chat(
    payload: dict,
    *,
    soul: str,
    rules: str,
    work_id: str,
    emitter: EventEmitter,
    tools_config: ToolsConfig | None = None,
    tool_loop_config: ToolLoopConfig | None = None,
    correlation_id: str | None = None,
) -> None:
    """Handle a chat work item: dispatch to terminal or legacy tool loop."""
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
            correlation_id=correlation_id,
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
            correlation_id=correlation_id,
            metadata={"work_id": work_id},
        )
        return

    # Dispatch: direct commands go to tmux, everything else goes through
    # the tool-use loop (LLM reasoning with tool calls visible in terminal)
    use_terminal = _should_use_terminal()

    if use_terminal:
        # Check if this is a direct shell command
        user_message = ""
        for msg in reversed(api_messages):
            if msg.get("role") == "user" and msg.get("content"):
                user_message = msg["content"]
                break

        if user_message and _classify_message(user_message) == "command":
            _run_terminal_task(
                api_messages=api_messages,
                soul=soul,
                rules=rules,
                callback_url=callback_url,
                chat_callback_token=chat_callback_token,
                message_id=message_id,
                thread_id=thread_id,
                work_id=work_id,
                emitter=emitter,
                correlation_id=correlation_id,
            )
            return

    # ── Tool-use loop: LLM reasons and executes via tools ──
    if not model_router_token:
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="error", error_message="MODEL_ROUTER_TOKEN not configured",
            emitter=emitter, work_id=work_id, correlation_id=correlation_id,
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

    # Inject tool-use instruction so the LLM knows to call tools
    if tool_defs:
        tool_names = ", ".join(t["function"]["name"] for t in tool_defs)
        tool_instruction = _build_tool_instruction(tool_names, tool_defs)
        if final_messages and final_messages[0].get("role") == "system":
            final_messages[0]["content"] += tool_instruction
        else:
            final_messages.insert(0, {"role": "system", "content": tool_instruction})
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
        correlation_id=correlation_id,
    )


# ─────────────────────────────────────────────────────────────────────
# Terminal dispatch (AI-181)
# ─────────────────────────────────────────────────────────────────────


def _should_use_terminal() -> bool:
    """Check if terminal dispatch is available and enabled."""
    if not os.environ.get("AGENT_USE_TERMINAL"):
        return False
    if not shutil.which("tmux"):
        return False
    return True


# Shell commands the agent can run directly in the terminal.
# Anything not matching gets routed to Claude Code CLI (if available)
# or the legacy tool-use loop.
_DIRECT_COMMAND_PREFIXES = frozenset((
    "ls", "cd", "pwd", "cat", "echo", "mkdir", "rm", "cp", "mv",
    "grep", "find", "head", "tail", "wc", "sort", "uniq", "diff",
    "chmod", "chown", "touch", "which", "whoami", "hostname",
    "date", "uptime", "df", "du", "free", "ps", "top", "htop",
    "git", "docker", "npm", "node", "python", "python3", "pip",
    "curl", "wget", "ssh", "scp", "tar", "zip", "unzip", "gzip",
    "make", "cmake", "cargo", "go", "ruby", "perl",
    "apt", "apt-get", "pip3", "yarn", "pnpm",
    "sed", "awk", "tr", "cut", "xargs", "tee",
    "env", "export", "source", "tree", "file", "stat", "readlink",
    "tmux", "screen", "clear", "reset", "history",
    "claude", "jq", "rg", "fd", "bat", "less", "more", "vi", "vim", "nano",
))

# Natural-language markers that indicate a task, not a command
_TASK_MARKERS = (
    "please", "can you", "help me", "i want", "i need",
    "could you", "would you", "write a", "create a", "build a",
    "fix the", "debug the", "explain", "refactor", "implement",
    "what is", "what are", "how do", "how to", "why does",
)


def _classify_message(message: str) -> str:
    """Classify a user message as 'command' or 'task'.

    'command' — direct shell command, run via tmux send-keys
    'task'    — complex request needing LLM reasoning (Claude Code or tool loop)
    """
    stripped = message.strip()
    if not stripped:
        return "task"

    # Strip leading prompt characters ($ > #)
    clean = stripped.lstrip("$>#").strip()
    if not clean:
        return "task"

    lower = clean.lower()

    # Natural-language markers → always a task
    for marker in _TASK_MARKERS:
        if marker in lower:
            return "task"

    # First word check against known commands
    first_word = clean.split()[0]
    # Handle path-style execution (./script.sh, /usr/bin/foo)
    if first_word.startswith("./") or first_word.startswith("/"):
        return "command"

    if first_word in _DIRECT_COMMAND_PREFIXES:
        return "command"

    # Pipe chains without natural language → command
    if "|" in clean and len(clean.split()) < 20:
        return "command"

    return "task"


# Shorter timeout for direct commands (they shouldn't take 10 min)
COMMAND_TIMEOUT = 60


def _ensure_tmux_session() -> None:
    """Ensure the tmux session exists, creating it if needed.

    The terminal WebSocket handler (ws_terminal.py) normally creates
    the session on first viewer connect, but chat may run before any
    viewer connects. This ensures send-keys has a target.
    """
    # Check if session exists
    result = subprocess.run(
        ["tmux", "has-session", "-t", TMUX_SESSION],
        capture_output=True,
        timeout=5,
    )
    if result.returncode == 0:
        return  # session exists

    # Create detached session with zsh
    zsh = shutil.which("zsh") or "/bin/bash"
    subprocess.run(
        ["tmux", "new-session", "-d", "-s", TMUX_SESSION, "-x", "120", "-y", "40"],
        capture_output=True,
        timeout=5,
    )
    logger.info("[terminal] Created tmux session '%s'", TMUX_SESSION)


def _run_terminal_task(
    *,
    api_messages: list[dict],
    soul: str,
    rules: str,
    callback_url: str,
    chat_callback_token: str,
    message_id: str,
    thread_id: str,
    work_id: str,
    emitter: EventEmitter,
    correlation_id: str | None = None,
) -> None:
    """Run a direct shell command in the visible tmux terminal.

    Only called for messages classified as 'command' (ls, git, etc.).
    Complex tasks go through the tool-use loop instead.
    """
    start_time = time.monotonic()

    # Extract the last user message
    user_message = ""
    for msg in reversed(api_messages):
        if msg.get("role") == "user" and msg.get("content"):
            user_message = msg["content"]
            break

    if not user_message:
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="error", error_message="No user message found",
            emitter=emitter, work_id=work_id, correlation_id=correlation_id,
        )
        return

    emitter.emit(
        type="terminal_task_start",
        tool="chat",
        input_summary=f"thread={thread_id} type=command task={user_message[:150]}",
        output_summary=None,
        duration_ms=None,
        success=None,
        correlation_id=correlation_id,
        metadata={"work_id": work_id, "message_id": message_id, "dispatch": "command"},
    )

    _deliver_callback(
        callback_url, chat_callback_token, message_id,
        status="thinking",
        content="Running command in terminal...",
        model="terminal",
        emitter=emitter, work_id=work_id, correlation_id=correlation_id,
    )

    try:
        result_content = _run_direct_command(user_message)

        duration_ms = int((time.monotonic() - start_time) * 1000)

        emitter.emit(
            type="terminal_task_complete",
            tool="chat",
            input_summary=f"thread={thread_id} type=command",
            output_summary=f"duration={duration_ms}ms result_len={len(result_content)}",
            duration_ms=duration_ms,
            success=True,
            correlation_id=correlation_id,
            metadata={"work_id": work_id, "message_id": message_id},
        )

        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="complete",
            content=result_content,
            model="terminal",
            duration_ms=duration_ms,
            emitter=emitter, work_id=work_id, correlation_id=correlation_id,
        )

    except Exception as exc:
        duration_ms = int((time.monotonic() - start_time) * 1000)
        logger.error("[terminal-task] Failed: %s", exc, exc_info=True)
        emitter.emit(
            type="terminal_task_failed",
            tool="chat",
            input_summary=f"thread={thread_id} type=command",
            output_summary=f"error={str(exc)[:200]}",
            duration_ms=duration_ms,
            success=False,
            correlation_id=correlation_id,
            metadata={"work_id": work_id, "message_id": message_id},
        )
        _deliver_callback(
            callback_url, chat_callback_token, message_id,
            status="error",
            error_message=f"Terminal task failed: {str(exc)[:200]}",
            duration_ms=duration_ms,
            emitter=emitter, work_id=work_id, correlation_id=correlation_id,
        )


def _run_direct_command(user_message: str) -> str:
    """Run a shell command directly in tmux and capture output.

    Terminal shows exactly what a user would see — just the command
    and its output. No wrappers, no tee, no sentinels.
    Output is captured via tmux capture-pane after the prompt returns.
    """
    cmd = user_message.strip().lstrip("$>#").strip()
    _ensure_tmux_session()

    # Send the raw command — exactly like a user typing it
    subprocess.run(
        ["tmux", "send-keys", "-t", TMUX_SESSION, cmd, "Enter"],
        timeout=5,
        capture_output=True,
    )

    logger.info("[terminal-cmd] Direct command in tmux: %s", cmd[:100])

    return _wait_and_capture(timeout=COMMAND_TIMEOUT)


def _run_visible_command(cmd: str) -> str:
    """Run a command in tmux (visible to terminal viewer) and return result as JSON.

    Used by the tool-use loop to make execute_command calls visible.
    """
    _ensure_tmux_session()

    subprocess.run(
        ["tmux", "send-keys", "-t", TMUX_SESSION, cmd, "Enter"],
        timeout=5,
        capture_output=True,
    )

    logger.info("[terminal-visible] Command in tmux: %s", cmd[:100])

    output = _wait_and_capture(timeout=COMMAND_TIMEOUT)
    return json.dumps({"success": True, "output": output, "exit_code": 0})


def _wait_and_capture(*, timeout: int) -> str:
    """Wait for the command to finish, then capture output from tmux pane.

    Detects completion by watching for the shell prompt to return
    (last non-empty line ends with $, #, %, or ❯).
    """
    deadline = time.monotonic() + timeout
    # Give the command a moment to start
    time.sleep(1)

    prev_content = ""
    stable_count = 0

    while time.monotonic() < deadline:
        time.sleep(1)
        try:
            result = subprocess.run(
                ["tmux", "capture-pane", "-t", TMUX_SESSION, "-p", "-S", "-50"],
                timeout=5,
                capture_output=True,
                text=True,
            )
            pane_content = result.stdout.rstrip()
            if not pane_content:
                continue

            # Check if the prompt has returned (command finished)
            last_line = pane_content.splitlines()[-1].rstrip()
            prompt_chars = ("$", "#", "%", "❯")
            if any(last_line.endswith(c) for c in prompt_chars):
                # Prompt is back — extract output (lines between command and prompt)
                lines = pane_content.splitlines()
                # Find the command line and return everything between it and the prompt
                output_lines = []
                found_cmd = False
                for line in lines:
                    if found_cmd:
                        # Stop at the prompt line
                        stripped = line.rstrip()
                        if any(stripped.endswith(c) for c in prompt_chars) and stripped != line.strip():
                            break
                        output_lines.append(line)
                    elif line.strip().endswith(last_line.strip()):
                        # Skip duplicate prompt lines
                        continue
                    # Look for our command in the line
                    if not found_cmd:
                        found_cmd = True  # Start capturing from next iteration

                output = "\n".join(output_lines).strip()
                return output if output else "Command completed."

            # Check if pane is stable (same content for 2 cycles = command still running)
            if pane_content == prev_content:
                stable_count += 1
            else:
                stable_count = 0
                prev_content = pane_content

        except Exception:
            continue

    # Timeout — capture whatever is in the pane
    try:
        result = subprocess.run(
            ["tmux", "capture-pane", "-t", TMUX_SESSION, "-p", "-S", "-50"],
            timeout=5, capture_output=True, text=True,
        )
        return f"{result.stdout.strip()}\n\n(Timed out after {timeout}s)"
    except Exception:
        return f"Timed out after {timeout}s."


# ─────────────────────────────────────────────────────────────────────
# Legacy tool-use loop (preserved for agents without terminal)
# ─────────────────────────────────────────────────────────────────────


def _build_tool_instruction(tool_names: str, tool_defs: list[dict]) -> str:
    """Build the tool-use system prompt section.

    Includes multi-step workflow guidance so the LLM plans before coding,
    verifies results, and iterates on failures instead of giving up.
    """
    has_shell = any(t["function"]["name"] == "execute_command" for t in tool_defs)
    has_write = any(t["function"]["name"] == "write_file" for t in tool_defs)
    has_read = any(t["function"]["name"] == "read_file" for t in tool_defs)

    parts = [
        f"\n\n## Tools\nYou have access to these tools: {tool_names}.",
        "",
        "When asked to run a command, read a file, write a file, or list a "
        "directory, you MUST use the appropriate tool. Do not guess outputs — "
        "always call the tool and show the real result.",
    ]

    # Only inject workflow guidance when the agent has coding-capable tools
    if has_shell and has_write and has_read:
        parts.append("")
        parts.append(
            "## Multi-Step Task Workflow\n"
            "For coding tasks (new features, bug fixes, refactors), follow this workflow:\n"
            "\n"
            "1. **Understand** — Read relevant files and explore the codebase before "
            "changing anything. Identify which files need edits and how they connect.\n"
            "2. **Plan** — State your approach in 2-3 sentences before writing code. "
            "If the task is ambiguous, ask the user to clarify.\n"
            "3. **Implement** — Make changes one file at a time. Write complete, "
            "working code — do not leave placeholder comments like `// TODO` or "
            "`# implement later`.\n"
            "4. **Verify** — After writing code, run the relevant test or validation "
            "command (e.g. `npm test`, `pytest`, `go test`, type-checking). If no "
            "test exists and the change is non-trivial, write one.\n"
            "5. **Iterate** — If tests fail, read the error output carefully, fix the "
            "issue, and re-run. Do not give up after one failure — keep going until "
            "tests pass or you hit a blocker you cannot resolve.\n"
            "\n"
            "Key principles:\n"
            "- Read before you write. Understand existing patterns and follow them.\n"
            "- Run commands to verify — do not assume your code is correct.\n"
            "- When a command fails, read the full error output before attempting a fix.\n"
            "- Keep changes minimal and focused on the task at hand."
        )

    return "\n".join(parts)


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
    correlation_id: str | None = None,
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
                emitter=emitter, work_id=work_id, correlation_id=correlation_id,
            )
            return

        emitter.emit(
            type="chat_inference_start",
            tool="chat",
            input_summary=f"thread={thread_id} model={model} iteration={iteration} messages={len(messages)}",
            output_summary=None,
            duration_ms=None,
            success=None,
            correlation_id=correlation_id,
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
                emitter=emitter, work_id=work_id, correlation_id=correlation_id,
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
                emitter=emitter, work_id=work_id, correlation_id=correlation_id,
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
                emitter=emitter, work_id=work_id, correlation_id=correlation_id,
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
            correlation_id=correlation_id,
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
                emitter=emitter, work_id=work_id, correlation_id=correlation_id,
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
                correlation_id=correlation_id,
                metadata={"work_id": work_id, "tool_call_id": tc_id},
            )

            tool_start = time.monotonic()
            try:
                # Route shell commands through tmux so they're visible
                if func_name == "execute_command" and _should_use_terminal():
                    cmd = func_args.get("command", "")
                    if cmd:
                        tool_result = _run_visible_command(cmd)
                    else:
                        tool_result = json.dumps({"success": False, "error": "No command provided"})
                else:
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
                correlation_id=correlation_id,
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
            emitter=emitter, work_id=work_id, correlation_id=correlation_id,
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
        emitter=emitter, work_id=work_id, correlation_id=correlation_id,
    )


# ─────────────────────────────────────────────────────────────────────
# Callback delivery (shared by both paths)
# ─────────────────────────────────────────────────────────────────────


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
    correlation_id: str | None = None,
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
            correlation_id=correlation_id,
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
            correlation_id=correlation_id,
            metadata={"work_id": work_id, "message_id": message_id},
        )
