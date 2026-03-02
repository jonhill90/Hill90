"""Tests for inference event emission to the API service."""

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


class TestInferenceEventEmission:
    """Inference activity event emission during chat completions."""

    def _setup_mocks(self, ed25519_keypair, make_jwt):
        """Common mock setup for chat completion tests with event capture."""
        _, public_pem = ed25519_keypair
        token = make_jwt()

        # Track all POSTs to the internal events endpoint
        captured_events = []

        # Mock DB connection
        mock_conn = AsyncMock()
        mock_conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "default",
            "allowed_models": ["gpt-4o-mini"],
            "max_requests_per_minute": None,
            "max_tokens_per_day": None,
        }
        mock_conn.execute.return_value = None
        mock_conn.fetchval.return_value = "user-owner-1"

        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=False)

        # Mock LiteLLM proxy response (success)
        mock_litellm_response = MagicMock()
        mock_litellm_response.status_code = 200
        mock_litellm_response.json.return_value = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "model": "gpt-4o-mini",
            "choices": [{"message": {"role": "assistant", "content": "Hello!"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        mock_litellm_response.headers = {
            "content-type": "application/json",
            "x-litellm-response-cost": "0.000325",
        }

        mock_http_client = AsyncMock()
        mock_http_client.post.return_value = mock_litellm_response

        return token, public_pem, mock_conn, mock_ctx, mock_http_client, captured_events

    @pytest.mark.asyncio
    async def test_chat_completions_emits_inference_start(self, ed25519_keypair, make_jwt):
        """Non-streaming chat completion emits inference_start event with correct agent_id."""
        from app.main import app
        import app.main as main_module

        token, public_pem, mock_conn, mock_ctx, mock_http_client, _ = self._setup_mocks(
            ed25519_keypair, make_jwt
        )

        captured_events = []

        async def capture_emit(agent_id, *, type, tool, input_summary, **kwargs):
            captured_events.append({
                "agent_id": agent_id,
                "type": type,
                "tool": tool,
                "input_summary": input_summary,
                **kwargs,
            })

        with (
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn", return_value=mock_ctx),
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.revocation_manager") as mock_revocation,
            patch("app.main._http_client", mock_http_client),
            patch("app.main.is_platform_model", new_callable=AsyncMock, return_value=True),
            patch("app.main.resolve_user_model", new_callable=AsyncMock, return_value=None),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-owner-1"),
            patch("app.main.emit_agent_event", side_effect=capture_emit) as mock_emit,
        ):
            mock_settings.return_value.litellm_url = "http://litellm:4000"
            mock_settings.return_value.litellm_master_key = "test-key"
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.api_service_url = "http://api:3000"
            mock_settings.return_value.provider_key_encryption_key = ""
            mock_revocation.revoked_jtis = set()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}]},
                )

            assert resp.status_code == 200

            start_events = [e for e in captured_events if e["type"] == "inference_start"]
            assert len(start_events) >= 1
            assert start_events[0]["agent_id"] == "test-agent-1"
            assert start_events[0]["tool"] == "inference"
            assert "gpt-4o-mini" in start_events[0]["input_summary"]

    @pytest.mark.asyncio
    async def test_chat_completions_emits_inference_complete(self, ed25519_keypair, make_jwt):
        """Non-streaming chat completion emits inference_complete with tokens/cost after success."""
        from app.main import app

        token, public_pem, mock_conn, mock_ctx, mock_http_client, _ = self._setup_mocks(
            ed25519_keypair, make_jwt
        )

        captured_events = []

        async def capture_emit(agent_id, *, type, tool, input_summary, **kwargs):
            captured_events.append({
                "agent_id": agent_id,
                "type": type,
                "tool": tool,
                "input_summary": input_summary,
                **kwargs,
            })

        with (
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn", return_value=mock_ctx),
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.revocation_manager") as mock_revocation,
            patch("app.main._http_client", mock_http_client),
            patch("app.main.is_platform_model", new_callable=AsyncMock, return_value=True),
            patch("app.main.resolve_user_model", new_callable=AsyncMock, return_value=None),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-owner-1"),
            patch("app.main.emit_agent_event", side_effect=capture_emit),
        ):
            mock_settings.return_value.litellm_url = "http://litellm:4000"
            mock_settings.return_value.litellm_master_key = "test-key"
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.api_service_url = "http://api:3000"
            mock_settings.return_value.provider_key_encryption_key = ""
            mock_revocation.revoked_jtis = set()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}]},
                )

            assert resp.status_code == 200

            complete_events = [e for e in captured_events if e["type"] == "inference_complete"]
            assert len(complete_events) == 1
            evt = complete_events[0]
            assert evt["success"] is True
            assert "tokens_in=" in evt["output_summary"]
            assert "tokens_out=" in evt["output_summary"]
            assert "cost=$" in evt["output_summary"]
            assert evt["duration_ms"] is not None
            assert evt["duration_ms"] >= 0

    @pytest.mark.asyncio
    async def test_chat_completions_emits_inference_error(self, ed25519_keypair, make_jwt):
        """Chat completion emits inference_error when LiteLLM proxy raises."""
        from app.main import app

        token, public_pem, mock_conn, mock_ctx, mock_http_client, _ = self._setup_mocks(
            ed25519_keypair, make_jwt
        )

        # Make proxy raise an exception
        mock_http_client.post.side_effect = Exception("LiteLLM connection refused")

        captured_events = []

        async def capture_emit(agent_id, *, type, tool, input_summary, **kwargs):
            captured_events.append({
                "agent_id": agent_id,
                "type": type,
                "tool": tool,
                "input_summary": input_summary,
                **kwargs,
            })

        with (
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn", return_value=mock_ctx),
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.revocation_manager") as mock_revocation,
            patch("app.main._http_client", mock_http_client),
            patch("app.main.is_platform_model", new_callable=AsyncMock, return_value=True),
            patch("app.main.resolve_user_model", new_callable=AsyncMock, return_value=None),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-owner-1"),
            patch("app.main.emit_agent_event", side_effect=capture_emit),
        ):
            mock_settings.return_value.litellm_url = "http://litellm:4000"
            mock_settings.return_value.litellm_master_key = "test-key"
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.api_service_url = "http://api:3000"
            mock_settings.return_value.provider_key_encryption_key = ""
            mock_revocation.revoked_jtis = set()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}]},
                )

            # Proxy error returns 502
            assert resp.status_code == 502

            error_events = [e for e in captured_events if e["type"] == "inference_error"]
            assert len(error_events) == 1
            assert error_events[0]["success"] is False

    @pytest.mark.asyncio
    async def test_streaming_emits_inference_events(self, ed25519_keypair, make_jwt):
        """Streaming chat completion emits both inference_start and inference_complete."""
        from app.main import app

        _, public_pem = ed25519_keypair
        token = make_jwt()

        mock_conn = AsyncMock()
        mock_conn.fetchrow.return_value = {
            "id": "policy-1",
            "name": "default",
            "allowed_models": ["gpt-4o-mini"],
            "max_requests_per_minute": None,
            "max_tokens_per_day": None,
        }
        mock_conn.execute.return_value = None
        mock_conn.fetchval.return_value = "user-owner-1"

        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=False)

        # Build a mock streaming response
        mock_response = AsyncMock()
        mock_response.status_code = 200
        mock_response.headers = {"content-type": "text/event-stream", "x-litellm-response-cost": "0.001"}

        async def fake_aiter_raw():
            yield b'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}],"usage":null}\n\n'
            yield b'data: {"id":"1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'
            yield b"data: [DONE]\n\n"

        mock_response.aiter_raw = fake_aiter_raw
        mock_response.aclose = AsyncMock()

        mock_http_client = AsyncMock()
        mock_http_client.build_request = MagicMock(return_value=MagicMock())
        mock_http_client.send = AsyncMock(return_value=mock_response)

        captured_events = []

        async def capture_emit(agent_id, *, type, tool, input_summary, **kwargs):
            captured_events.append({
                "agent_id": agent_id,
                "type": type,
                "tool": tool,
                "input_summary": input_summary,
                **kwargs,
            })

        with (
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn", return_value=mock_ctx),
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.revocation_manager") as mock_revocation,
            patch("app.main._http_client", mock_http_client),
            patch("app.main.is_platform_model", new_callable=AsyncMock, return_value=True),
            patch("app.main.resolve_user_model", new_callable=AsyncMock, return_value=None),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-owner-1"),
            patch("app.main.emit_agent_event", side_effect=capture_emit),
        ):
            mock_settings.return_value.litellm_url = "http://litellm:4000"
            mock_settings.return_value.litellm_master_key = "test-key"
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.api_service_url = "http://api:3000"
            mock_settings.return_value.provider_key_encryption_key = ""
            mock_revocation.revoked_jtis = set()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [{"role": "user", "content": "Hi"}],
                        "stream": True,
                    },
                )

                # Consume the streaming response
                body = b""
                async for chunk in resp.aiter_bytes():
                    body += chunk

            assert resp.status_code == 200

            start_events = [e for e in captured_events if e["type"] == "inference_start"]
            assert len(start_events) >= 1
            assert start_events[0]["agent_id"] == "test-agent-1"

            complete_events = [e for e in captured_events if e["type"] == "inference_complete"]
            assert len(complete_events) == 1

    @pytest.mark.asyncio
    async def test_inference_event_summaries_metadata_only(self, ed25519_keypair, make_jwt):
        """Inference events contain no prompt or completion content, only metadata."""
        from app.main import app

        token, public_pem, mock_conn, mock_ctx, mock_http_client, _ = self._setup_mocks(
            ed25519_keypair, make_jwt
        )

        captured_events = []

        async def capture_emit(agent_id, *, type, tool, input_summary, **kwargs):
            captured_events.append({
                "agent_id": agent_id,
                "type": type,
                "tool": tool,
                "input_summary": input_summary,
                **kwargs,
            })

        with (
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn", return_value=mock_ctx),
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.revocation_manager") as mock_revocation,
            patch("app.main._http_client", mock_http_client),
            patch("app.main.is_platform_model", new_callable=AsyncMock, return_value=True),
            patch("app.main.resolve_user_model", new_callable=AsyncMock, return_value=None),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-owner-1"),
            patch("app.main.emit_agent_event", side_effect=capture_emit),
        ):
            mock_settings.return_value.litellm_url = "http://litellm:4000"
            mock_settings.return_value.litellm_master_key = "test-key"
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.api_service_url = "http://api:3000"
            mock_settings.return_value.provider_key_encryption_key = ""
            mock_revocation.revoked_jtis = set()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [{"role": "user", "content": "This is secret prompt text"}],
                    },
                )

            assert resp.status_code == 200

            # Check that no event contains the actual prompt or completion content
            for event in captured_events:
                event_str = json.dumps(event)
                assert "secret prompt" not in event_str
                assert "Hello!" not in event_str

    @pytest.mark.asyncio
    async def test_event_emission_failure_does_not_break_inference(
        self, ed25519_keypair, make_jwt
    ):
        """If the event emission fails (e.g. API returns 500), inference still returns 200."""
        from app.main import app

        token, public_pem, mock_conn, mock_ctx, mock_http_client, _ = self._setup_mocks(
            ed25519_keypair, make_jwt
        )

        async def failing_emit(agent_id, *, type, tool, input_summary, **kwargs):
            raise Exception("API service down")

        with (
            patch("app.main.get_public_key", return_value=public_pem),
            patch("app.main.get_db_conn", return_value=mock_ctx),
            patch("app.main.get_settings") as mock_settings,
            patch("app.main.revocation_manager") as mock_revocation,
            patch("app.main._http_client", mock_http_client),
            patch("app.main.is_platform_model", new_callable=AsyncMock, return_value=True),
            patch("app.main.resolve_user_model", new_callable=AsyncMock, return_value=None),
            patch("app.main.get_agent_owner", new_callable=AsyncMock, return_value="user-owner-1"),
            patch("app.main.emit_agent_event", side_effect=failing_emit),
        ):
            mock_settings.return_value.litellm_url = "http://litellm:4000"
            mock_settings.return_value.litellm_master_key = "test-key"
            mock_settings.return_value.model_router_internal_service_token = "svc-token"
            mock_settings.return_value.api_service_url = "http://api:3000"
            mock_settings.return_value.provider_key_encryption_key = ""
            mock_revocation.revoked_jtis = set()

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await client.post(
                    "/v1/chat/completions",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}]},
                )

            # Inference still succeeds despite event emission failure
            assert resp.status_code == 200
            data = resp.json()
            assert data["choices"][0]["message"]["content"] == "Hello!"
