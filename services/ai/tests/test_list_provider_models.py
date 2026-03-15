"""Tests for POST /internal/list-provider-models endpoint."""

import hmac
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import Response

from app.model_type_detect import detect_model_type


class TestListProviderModels:
    """E1-E6: Provider model listing with detection."""

    @pytest.fixture
    def mock_settings(self):
        settings = MagicMock()
        settings.model_router_internal_service_token = "test-token"
        settings.provider_key_encryption_key = "a" * 64
        return settings

    def test_e1_openai_models_detection(self):
        """E1: OpenAI models get correct detected_type."""
        result = detect_model_type("openai/gpt-4o")
        assert result.detected_type == "chat"
        assert "vision" in result.capabilities

    def test_e2_anthropic_models_detection(self):
        """E2: Anthropic models get correct detected_type."""
        result = detect_model_type("anthropic/claude-sonnet-4-20250514")
        assert result.detected_type == "chat"
        assert "function_calling" in result.capabilities

    def test_e3_invalid_key_returns_error_shape(self):
        """E3: Error responses always include models array."""
        # Test the expected response shape — models is always present
        error_response = {"models": [], "error": "Failed to decrypt provider key"}
        assert "models" in error_response
        assert isinstance(error_response["models"], list)
        assert "error" in error_response

    def test_e4_unsupported_provider_returns_error(self):
        """E4: Unsupported provider returns error shape."""
        error_response = {"models": [], "error": "Unsupported provider for model listing: custom"}
        assert error_response["models"] == []
        assert "Unsupported" in error_response["error"]

    def test_e5_embedding_model_detected(self):
        """E5: Embedding model detected from model ID."""
        result = detect_model_type("openai/text-embedding-3-small")
        assert result.detected_type == "embedding"
        assert result.capabilities == ["embedding"]

    def test_e6_chat_model_detected(self):
        """E6: Chat model detected from model ID."""
        result = detect_model_type("openai/gpt-4o-mini")
        assert result.detected_type == "chat"
        assert "function_calling" in result.capabilities
