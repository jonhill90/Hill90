"""Tests for inference contract verification (AI-121).

S1: _handle_streaming signature has parameter named resolved_model.
"""

import inspect


class TestStreamingParameterRename:
    """Verify _handle_streaming parameter name matches its semantics."""

    def test_handle_streaming_has_resolved_model_param(self):
        """S1: _handle_streaming parameter is named resolved_model, not requested_model."""
        from app.main import _handle_streaming

        sig = inspect.signature(_handle_streaming)
        param_names = list(sig.parameters.keys())

        # The 4th positional parameter (after settings, body, claims) should be
        # 'resolved_model' — not the misleading 'requested_model'
        assert "resolved_model" in param_names, (
            f"Expected 'resolved_model' in _handle_streaming params, got: {param_names}"
        )
        assert "requested_model" not in [
            p for p in param_names if sig.parameters[p].kind
            in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ], (
            "'requested_model' should not be a positional parameter of _handle_streaming"
        )
