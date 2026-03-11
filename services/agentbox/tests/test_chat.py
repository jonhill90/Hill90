"""Tests for app.chat — chat work handler (inference + callback)."""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

from app.chat import handle_chat, _deliver_callback
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
