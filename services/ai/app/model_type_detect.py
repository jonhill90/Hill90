"""Canonical model type detection contract (D7).

Rules evaluated top-to-bottom, first match wins.
This specification is implemented identically in TypeScript (model-type-detect.ts).
Parity enforced by shared test vectors H1-H7 in both test suites.
"""

from dataclasses import dataclass, field


@dataclass
class DetectedModel:
    detected_type: str
    capabilities: list[str] = field(default_factory=list)


# (test_fn, detected_type, capabilities)
_DETECTION_RULES: list[tuple[callable, str, list[str]]] = [
    (lambda m: "embed" in m, "embedding", ["embedding"]),
    (lambda m: "tts" in m or "audio" in m, "audio", ["audio"]),
    (lambda m: "dall-e" in m or "image-generation" in m, "image", ["image_generation"]),
    (lambda m: "whisper" in m or "transcription" in m, "transcription", ["transcription"]),
    # gpt-4o but NOT gpt-4o-mini
    (lambda m: "gpt-4o" in m and "gpt-4o-mini" not in m, "chat", ["chat", "function_calling", "vision"]),
    (lambda m: "gpt-4o-mini" in m, "chat", ["chat", "function_calling"]),
    (lambda m: "claude-" in m, "chat", ["chat", "function_calling"]),
]


def detect_model_type(litellm_model: str) -> DetectedModel:
    lower = litellm_model.lower()
    for test_fn, detected_type, capabilities in _DETECTION_RULES:
        if test_fn(lower):
            return DetectedModel(detected_type=detected_type, capabilities=list(capabilities))
    return DetectedModel(detected_type="chat", capabilities=["chat"])
