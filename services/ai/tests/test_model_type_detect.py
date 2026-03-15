"""Shared test vectors H1-H7 for D7 parity.

Identical hardcoded input/output pairs in both TS and Python test suites.
"""

from app.model_type_detect import detect_model_type


class TestDetectModelTypeParity:
    """D7 parity vectors — must match TypeScript implementation exactly."""

    def test_h1_embedding(self):
        result = detect_model_type("openai/text-embedding-3-small")
        assert result.detected_type == "embedding"
        assert result.capabilities == ["embedding"]

    def test_h2_gpt4o_chat_vision(self):
        result = detect_model_type("openai/gpt-4o")
        assert result.detected_type == "chat"
        assert result.capabilities == ["chat", "function_calling", "vision"]

    def test_h3_gpt4o_mini_chat(self):
        result = detect_model_type("openai/gpt-4o-mini")
        assert result.detected_type == "chat"
        assert result.capabilities == ["chat", "function_calling"]

    def test_h4_claude_chat(self):
        result = detect_model_type("anthropic/claude-sonnet-4-20250514")
        assert result.detected_type == "chat"
        assert result.capabilities == ["chat", "function_calling"]

    def test_h5_tts_audio(self):
        result = detect_model_type("openai/tts-1")
        assert result.detected_type == "audio"
        assert result.capabilities == ["audio"]

    def test_h6_dalle_image(self):
        result = detect_model_type("openai/dall-e-3")
        assert result.detected_type == "image"
        assert result.capabilities == ["image_generation"]

    def test_h7_unknown_default(self):
        result = detect_model_type("some-unknown-model")
        assert result.detected_type == "chat"
        assert result.capabilities == ["chat"]
