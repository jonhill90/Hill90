"""Tests for app.chat — chat work handler (inference + callback + tool loop)."""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from app.chat import handle_chat, _build_tool_instruction, _deliver_callback, _should_use_terminal
from app.config import FilesystemConfig, ShellConfig, ToolLoopConfig, ToolsConfig
from app.events import EventEmitter


@pytest.fixture
def emitter(tmp_path):
    log_path = tmp_path / "events.jsonl"
    return EventEmitter(str(log_path)), log_path


def _read_events(log_path):
    """Read all JSONL events from log file."""
    if not log_path.exists():
        return []
    events = []
    for line in log_path.read_text().splitlines():
        if line.strip():
            events.append(json.loads(line))
    return events


class TestHandleChatMissingConfig:
    def test_missing_callback_url(self, emitter):
        em, log_path = emitter
        handle_chat(
            {"thread_id": "t1", "message_id": "m1", "messages": [], "model": "gpt-4o-mini"},
            soul="", rules="", work_id="w1", emitter=em,
        )
        events = _read_events(log_path)
        assert any(e["type"] == "work_failed" and "callback_url" in e.get("output_summary", "") for e in events)

    def test_missing_chat_callback_token(self, emitter, monkeypatch):
        em, log_path = emitter
        monkeypatch.delenv("CHAT_CALLBACK_TOKEN", raising=False)
        handle_chat(
            {"thread_id": "t1", "message_id": "m1", "messages": [],
             "model": "gpt-4o-mini", "callback_url": "http://api:3000/internal/chat/callback"},
            soul="", rules="", work_id="w1", emitter=em,
        )
        events = _read_events(log_path)
        assert any(e["type"] == "work_failed" and "CHAT_CALLBACK_TOKEN" in e.get("output_summary", "") for e in events)

    @patch("app.chat.requests.post")
    def test_missing_model_router_token(self, mock_post, emitter, monkeypatch):
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.delenv("MODEL_ROUTER_TOKEN", raising=False)

        # Callback delivery should still work
        mock_post.return_value = MagicMock(status_code=200, text="ok")

        handle_chat(
            {"thread_id": "t1", "message_id": "m1", "messages": [],
             "model": "gpt-4o-mini", "callback_url": "http://api:3000/cb"},
            soul="", rules="", work_id="w1", emitter=em,
        )

        # Should have called callback with error status
        assert mock_post.called
        call_body = mock_post.call_args_list[0][1]["json"]
        assert call_body["status"] == "error"
        assert "MODEL_ROUTER_TOKEN" in call_body["error_message"]


class TestHandleChatInference:
    @patch("app.chat.requests.post")
    def test_successful_inference_and_callback(self, mock_post, emitter, monkeypatch):
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")
        monkeypatch.setenv("AI_SERVICE_URL", "http://ai:8000")

        # Mock AI response
        ai_response = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{"message": {"content": "Hello from agent!"}}],
                "usage": {"prompt_tokens": 42, "completion_tokens": 128},
                "model": "gpt-4o-mini",
            },
        )
        # Mock callback response
        cb_response = MagicMock(status_code=200, text="ok")
        mock_post.side_effect = [ai_response, cb_response]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hello"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="You are a helpful agent.",
            rules="Follow these rules.",
            work_id="w1",
            emitter=em,
        )

        assert mock_post.call_count == 2

        # Check AI service call
        ai_call = mock_post.call_args_list[0]
        ai_body = ai_call[1]["json"]
        assert ai_body["messages"][0]["role"] == "system"
        assert "helpful agent" in ai_body["messages"][0]["content"]
        assert ai_body["messages"][1]["role"] == "user"
        assert ai_body["messages"][1]["content"] == "Hello"
        assert ai_call[1]["headers"]["Authorization"] == "Bearer mr-token"

        # Check callback
        cb_call = mock_post.call_args_list[1]
        cb_body = cb_call[1]["json"]
        assert cb_body["message_id"] == "m1"
        assert cb_body["status"] == "complete"
        assert cb_body["content"] == "Hello from agent!"
        assert cb_body["input_tokens"] == 42
        assert cb_body["output_tokens"] == 128
        assert cb_call[1]["headers"]["Authorization"] == "Bearer cb-token"

        events = _read_events(log_path)
        event_types = [e["type"] for e in events]
        assert "chat_inference_start" in event_types
        assert "chat_inference_complete" in event_types
        assert "chat_callback_sent" in event_types

    @patch("app.chat.requests.post")
    def test_inference_failure_delivers_error_callback(self, mock_post, emitter, monkeypatch):
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        # AI returns error
        ai_response = MagicMock(status_code=500, text="Internal Server Error")
        cb_response = MagicMock(status_code=200, text="ok")
        mock_post.side_effect = [ai_response, cb_response]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hello"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
        )

        # Should have sent error callback
        cb_body = mock_post.call_args_list[1][1]["json"]
        assert cb_body["status"] == "error"
        assert "Inference failed" in cb_body["error_message"]

    @patch("app.chat.requests.post")
    def test_inference_timeout_delivers_error_callback(self, mock_post, emitter, monkeypatch):
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        import requests as req_lib
        mock_post.side_effect = [req_lib.Timeout("timed out"), MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [], "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
        )

        cb_body = mock_post.call_args_list[1][1]["json"]
        assert cb_body["status"] == "error"
        assert "timed out" in cb_body["error_message"]


class TestDeliverCallback:
    @patch("app.chat.requests.post")
    def test_callback_delivery_success(self, mock_post, emitter):
        em, log_path = emitter
        mock_post.return_value = MagicMock(status_code=200, text="ok")

        _deliver_callback(
            "http://api:3000/cb", "token", "m1",
            status="complete", content="Hello",
            emitter=em, work_id="w1",
        )

        assert mock_post.called
        events = _read_events(log_path)
        assert any(e["type"] == "chat_callback_sent" and e["success"] is True for e in events)

    @patch("app.chat.requests.post")
    def test_callback_delivery_failure(self, mock_post, emitter):
        em, log_path = emitter
        mock_post.side_effect = Exception("Connection refused")

        _deliver_callback(
            "http://api:3000/cb", "token", "m1",
            status="complete", content="Hello",
            emitter=em, work_id="w1",
        )

        events = _read_events(log_path)
        assert any(e["type"] == "chat_callback_failed" for e in events)


class TestSystemPromptAssembly:
    @patch("app.chat.requests.post")
    def test_system_prompt_includes_soul_and_rules(self, mock_post, emitter, monkeypatch):
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {"choices": [{"message": {"content": "ok"}}], "usage": {}, "model": "m"},
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="I am TestBot",
            rules="Rule 1: Be nice",
            work_id="w1",
            emitter=em,
        )

        ai_body = mock_post.call_args_list[0][1]["json"]
        system_msg = ai_body["messages"][0]
        assert system_msg["role"] == "system"
        assert "I am TestBot" in system_msg["content"]
        assert "Rule 1: Be nice" in system_msg["content"]

    @patch("app.chat.requests.post")
    def test_no_system_prompt_when_empty(self, mock_post, emitter, monkeypatch):
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {"choices": [{"message": {"content": "ok"}}], "usage": {}, "model": "m"},
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="",
            work_id="w1",
            emitter=em,
        )

        ai_body = mock_post.call_args_list[0][1]["json"]
        # No system message when both soul and rules are empty
        assert ai_body["messages"][0]["role"] == "user"


class TestGroupChatContext:
    """AI-146: Group thread context in system prompt."""

    @patch("app.chat.requests.post")
    def test_group_chat_includes_participants(self, mock_post, emitter, monkeypatch):
        """T8: Group payload injects participant names into system prompt."""
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {"choices": [{"message": {"content": "ok"}}], "usage": {}, "model": "m"},
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi all"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
                "thread_type": "group",
                "participants": [
                    {"agent_id": "alpha", "name": "Alpha"},
                    {"agent_id": "beta", "name": "Beta"},
                ],
            },
            soul="I am TestBot",
            rules="Rule 1: Be nice",
            work_id="w1",
            emitter=em,
        )

        ai_body = mock_post.call_args_list[0][1]["json"]
        system_msg = ai_body["messages"][0]
        assert system_msg["role"] == "system"
        assert "Group Thread" in system_msg["content"]
        assert "@alpha" in system_msg["content"]
        assert "@beta" in system_msg["content"]
        assert "@slug" in system_msg["content"]
        # Original soul + rules still present
        assert "I am TestBot" in system_msg["content"]
        assert "Rule 1: Be nice" in system_msg["content"]

    @patch("app.chat.requests.post")
    def test_direct_chat_no_participant_context(self, mock_post, emitter, monkeypatch):
        """T9: Direct payload does not alter system prompt."""
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {"choices": [{"message": {"content": "ok"}}], "usage": {}, "model": "m"},
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
                # No thread_type or participants — direct thread
            },
            soul="I am TestBot",
            rules="Rule 1: Be nice",
            work_id="w1",
            emitter=em,
        )

        ai_body = mock_post.call_args_list[0][1]["json"]
        system_msg = ai_body["messages"][0]
        assert system_msg["role"] == "system"
        assert "Group Thread" not in system_msg["content"]
        assert "I am TestBot" in system_msg["content"]


class TestToolLoop:
    """AI-150: Tool-calling loop tests."""

    @patch("app.chat.requests.post")
    def test_single_shot_no_tools(self, mock_post, emitter, monkeypatch):
        """When no tools are enabled, behavior is identical to pre-tool-loop."""
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{"message": {"content": "Hello!"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                "model": "gpt-4o-mini",
            },
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
            tools_config=ToolsConfig(),  # all disabled
        )

        # AI call should NOT include tools
        ai_body = mock_post.call_args_list[0][1]["json"]
        assert "tools" not in ai_body

        cb_body = mock_post.call_args_list[1][1]["json"]
        assert cb_body["status"] == "complete"
        assert cb_body["content"] == "Hello!"

    @patch("app.chat.execute_tool_call")
    @patch("app.chat.requests.post")
    def test_tool_loop_single_iteration(self, mock_post, mock_tool, emitter, monkeypatch):
        """LLM calls one tool, gets result, then responds with text."""
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        # First LLM call: returns a tool call
        tool_call_response = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{
                    "message": {
                        "content": "",
                        "tool_calls": [{
                            "id": "tc-1",
                            "type": "function",
                            "function": {
                                "name": "execute_command",
                                "arguments": '{"command": "ls /workspace"}',
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10},
                "model": "gpt-4o-mini",
            },
        )

        # Second LLM call: final text response
        final_response = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{"message": {"content": "I see files."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 15},
                "model": "gpt-4o-mini",
            },
        )

        # Callback responses (thinking + final)
        cb_ok = MagicMock(status_code=200, text="ok")
        mock_post.side_effect = [tool_call_response, cb_ok, final_response, cb_ok]

        # Mock tool execution — return a coroutine each time called
        async def _fake_tool(*args, **kwargs):
            return json.dumps({"success": True, "exit_code": 0, "stdout": "file1.txt\n", "stderr": ""})
        mock_tool.side_effect = _fake_tool

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "List files"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
            tools_config=ToolsConfig(shell=ShellConfig(enabled=True)),
        )

        # Should have: AI call (tool) + thinking callback + AI call (final) + complete callback = 4 posts
        assert mock_post.call_count == 4

        # First AI call should include tools
        ai_body_1 = mock_post.call_args_list[0][1]["json"]
        assert "tools" in ai_body_1
        assert any(t["function"]["name"] == "execute_command" for t in ai_body_1["tools"])

        # Thinking callback
        thinking_body = mock_post.call_args_list[1][1]["json"]
        assert thinking_body["status"] == "thinking"
        assert "execute_command" in thinking_body["content"]

        # Final callback
        final_body = mock_post.call_args_list[3][1]["json"]
        assert final_body["status"] == "complete"
        assert final_body["content"] == "I see files."
        # Cumulative tokens
        assert final_body["input_tokens"] == 70  # 20 + 50
        assert final_body["output_tokens"] == 25  # 10 + 15

    @patch("app.chat.execute_tool_call")
    @patch("app.chat.requests.post")
    def test_tool_loop_max_iterations(self, mock_post, mock_tool, emitter, monkeypatch):
        """Loop stops at max_iterations even if LLM keeps requesting tools."""
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        # Always return tool calls
        def make_tool_response():
            return MagicMock(
                status_code=200,
                json=lambda: {
                    "choices": [{
                        "message": {
                            "content": "",
                            "tool_calls": [{
                                "id": "tc-x",
                                "type": "function",
                                "function": {"name": "execute_command", "arguments": '{"command": "echo loop"}'},
                            }],
                        },
                        "finish_reason": "tool_calls",
                    }],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                    "model": "gpt-4o-mini",
                },
            )

        cb_ok = MagicMock(status_code=200, text="ok")
        # 3 iterations × (1 AI call + 1 thinking callback) + 1 final callback = 7
        mock_post.side_effect = [
            make_tool_response(), cb_ok,
            make_tool_response(), cb_ok,
            make_tool_response(), cb_ok,
            cb_ok,  # final complete callback
        ]

        async def _fake_tool(*args, **kwargs):
            return json.dumps({"success": True})
        mock_tool.side_effect = _fake_tool

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Loop test"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
            tools_config=ToolsConfig(shell=ShellConfig(enabled=True)),
            tool_loop_config=ToolLoopConfig(max_iterations=3),
        )

        # Last callback should be complete (not error)
        last_cb = None
        for call in mock_post.call_args_list:
            body = call[1].get("json", {})
            if body.get("status") in ("complete", "error"):
                last_cb = body
        assert last_cb is not None
        assert last_cb["status"] == "complete"

    @patch("app.chat.requests.post")
    def test_tools_included_when_enabled(self, mock_post, emitter, monkeypatch):
        """Tool definitions are included in LLM request when shell/filesystem enabled."""
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "usage": {}, "model": "m",
            },
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
            tools_config=ToolsConfig(
                shell=ShellConfig(enabled=True),
                filesystem=FilesystemConfig(enabled=True),
            ),
        )

        ai_body = mock_post.call_args_list[0][1]["json"]
        assert "tools" in ai_body
        tool_names = [t["function"]["name"] for t in ai_body["tools"]]
        assert "execute_command" in tool_names
        assert "read_file" in tool_names
        assert "write_file" in tool_names
        assert "list_directory" in tool_names


class TestBuildToolInstruction:
    """AI-169: Multi-step task workflow in tool instruction."""

    def test_includes_tool_names(self):
        tool_defs = [
            {"function": {"name": "execute_command"}},
            {"function": {"name": "read_file"}},
        ]
        result = _build_tool_instruction("execute_command, read_file", tool_defs)
        assert "execute_command, read_file" in result

    def test_multistep_workflow_with_full_tools(self):
        """Workflow section appears when shell + read + write are all enabled."""
        tool_defs = [
            {"function": {"name": "execute_command"}},
            {"function": {"name": "read_file"}},
            {"function": {"name": "write_file"}},
            {"function": {"name": "list_directory"}},
        ]
        result = _build_tool_instruction(
            "execute_command, read_file, write_file, list_directory", tool_defs,
        )
        assert "Multi-Step Task Workflow" in result

    def test_no_multistep_without_write(self):
        """Read-only agents should not get the coding workflow."""
        tool_defs = [
            {"function": {"name": "execute_command"}},
            {"function": {"name": "read_file"}},
            {"function": {"name": "list_directory"}},
        ]
        result = _build_tool_instruction(
            "execute_command, read_file, list_directory", tool_defs,
        )
        assert "Multi-Step Task Workflow" not in result

    def test_no_multistep_shell_only(self):
        """Shell-only agents should not get the coding workflow."""
        tool_defs = [{"function": {"name": "execute_command"}}]
        result = _build_tool_instruction("execute_command", tool_defs)
        assert "Multi-Step Task Workflow" not in result


class TestTerminalDispatch:
    """AI-181: Terminal dispatch mode — run claude CLI in tmux."""

    def test_should_use_terminal_disabled_by_default(self, monkeypatch):
        """Terminal dispatch is off when AGENT_USE_TERMINAL is not set."""
        monkeypatch.delenv("AGENT_USE_TERMINAL", raising=False)
        assert _should_use_terminal() is False

    @patch("app.chat.shutil.which")
    def test_should_use_terminal_enabled(self, mock_which, monkeypatch):
        """Terminal dispatch is on when env var + tmux + claude are available."""
        monkeypatch.setenv("AGENT_USE_TERMINAL", "1")
        mock_which.side_effect = lambda cmd: f"/usr/bin/{cmd}"
        assert _should_use_terminal() is True

    @patch("app.chat.shutil.which")
    def test_should_use_terminal_no_claude_still_works(self, mock_which, monkeypatch):
        """Terminal dispatch is ON even without claude — it's just one tool."""
        monkeypatch.setenv("AGENT_USE_TERMINAL", "1")
        mock_which.side_effect = lambda cmd: f"/usr/bin/{cmd}" if cmd == "tmux" else None
        assert _should_use_terminal() is True

    @patch("app.chat.shutil.which")
    def test_should_use_terminal_no_tmux(self, mock_which, monkeypatch):
        """Terminal dispatch is off when tmux is missing."""
        monkeypatch.setenv("AGENT_USE_TERMINAL", "1")
        mock_which.side_effect = lambda cmd: f"/usr/bin/{cmd}" if cmd == "claude" else None
        assert _should_use_terminal() is False

    @patch("app.chat._should_use_terminal", return_value=True)
    @patch("app.chat.requests.post")
    def test_complex_task_goes_to_tool_loop_not_terminal(
        self, mock_post, mock_terminal, emitter, monkeypatch
    ):
        """Complex tasks (natural language) go through tool-use loop, not terminal dispatch."""
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        # Mock LLM response (no tool calls = final response)
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{"message": {"content": "I'll create that file.", "tool_calls": None}, "finish_reason": "stop"}],
                "model": "gpt-4o-mini",
                "usage": {"prompt_tokens": 100, "completion_tokens": 20},
            },
        )

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Create a hello.py file"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="You are a coding agent.", rules="Be concise.",
            work_id="w1", emitter=em,
        )

        # Should have called the LLM (inference endpoint), not tmux
        inference_calls = [c for c in mock_post.call_args_list
                          if "chat/completions" in str(c)]
        assert len(inference_calls) >= 1, "Expected LLM inference call for complex task"

    @patch("app.chat._poll_for_result_file")
    @patch("app.chat.subprocess.run")
    @patch("app.chat._should_use_terminal", return_value=True)
    @patch("app.chat.requests.post")
    def test_terminal_dispatch_direct_command_skips_claude(
        self, mock_post, mock_terminal, mock_subprocess, mock_poll, emitter, monkeypatch, tmp_path
    ):
        """Direct shell commands (ls, git, etc.) run directly in tmux without Claude."""
        em, log_path = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setattr("app.chat.RESULT_FILE", str(tmp_path / "result"))

        mock_post.return_value = MagicMock(status_code=200)
        mock_subprocess.return_value = MagicMock(returncode=0)
        mock_poll.return_value = "file1.txt\nfile2.py\n"

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "ls -a"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="You are an agent.", rules="",
            work_id="w1", emitter=em,
        )

        # tmux send-keys was called with the command (not claude)
        assert mock_subprocess.called
        send_keys_call = mock_subprocess.call_args
        cmd_args = send_keys_call[0][0]
        assert "tmux" in cmd_args
        assert "send-keys" in cmd_args
        # The command string (before "Enter") should contain ls -a
        tmux_cmd = cmd_args[-2]
        assert "ls -a" in tmux_cmd
        assert "claude" not in tmux_cmd

    @patch("app.chat._should_use_terminal", return_value=True)
    @patch("app.chat.requests.post")
    def test_no_user_message_falls_to_tool_loop(self, mock_post, mock_terminal, emitter, monkeypatch):
        """No user message with terminal on falls to tool loop (needs MODEL_ROUTER_TOKEN)."""
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        # No MODEL_ROUTER_TOKEN → tool loop returns error
        monkeypatch.delenv("MODEL_ROUTER_TOKEN", raising=False)

        mock_post.return_value = MagicMock(status_code=200)

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "assistant", "content": "I'm ready"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
        )

        # Should have sent error callback about missing token
        cb_body = mock_post.call_args[1]["json"]
        assert cb_body["status"] == "error"

    @patch("app.chat._should_use_terminal", return_value=False)
    @patch("app.chat.requests.post")
    def test_legacy_path_when_terminal_disabled(self, mock_post, mock_terminal, emitter, monkeypatch):
        """When terminal is disabled, falls through to legacy tool loop."""
        em, _ = emitter
        monkeypatch.setenv("CHAT_CALLBACK_TOKEN", "cb-token")
        monkeypatch.setenv("MODEL_ROUTER_TOKEN", "mr-token")

        ai_response = MagicMock(
            status_code=200,
            json=lambda: {
                "choices": [{"message": {"content": "Hello!"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                "model": "gpt-4o-mini",
            },
        )
        mock_post.side_effect = [ai_response, MagicMock(status_code=200)]

        handle_chat(
            {
                "thread_id": "t1", "message_id": "m1",
                "messages": [{"role": "user", "content": "Hi"}],
                "model": "gpt-4o-mini",
                "callback_url": "http://api:3000/cb",
            },
            soul="", rules="", work_id="w1", emitter=em,
        )

        # Should have called AI service (legacy path)
        ai_call = mock_post.call_args_list[0]
        assert "v1/chat/completions" in ai_call[0][0]
