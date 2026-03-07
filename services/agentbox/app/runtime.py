"""AgentRuntime — workload receiver and identity loader.

Provides the POST /work endpoint contract for receiving work items.
Phase 2: stub implementation — accepts work, emits events, returns ack.
No execution logic (Phase 3+).
"""

from __future__ import annotations

import logging
import os
import uuid

from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import AgentConfig
from app.events import EventEmitter

logger = logging.getLogger(__name__)


class AgentRuntime:
    """Runtime workload receiver with bearer auth and structured events."""

    def __init__(
        self,
        config: AgentConfig,
        emitter: EventEmitter,
        work_token: str | None,
    ) -> None:
        self._config = config
        self._emitter = emitter
        self._work_token = work_token

        # Load identity files (same paths as the removed identity tool)
        self.soul: str = ""
        self.rules: str = ""
        self._load_identity()

    def _load_identity(self) -> None:
        soul_path = "/etc/agentbox/SOUL.md"
        rules_path = "/etc/agentbox/RULES.md"

        if os.path.exists(soul_path):
            with open(soul_path) as f:
                self.soul = f.read()

        if os.path.exists(rules_path):
            with open(rules_path) as f:
                self.rules = f.read()

    async def handle_work(self, request: Request) -> JSONResponse:
        """Handle POST /work — validate, emit events, return ack.

        Auth: Bearer token from WORK_TOKEN env var.
        Schema: { "type": str, "payload": dict, "correlation_id": str | None }
        """
        # 1. Auth check
        if not self._check_auth(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)

        # 2. Parse JSON body
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(
                {"error": "validation_error", "detail": "Malformed JSON body"},
                status_code=400,
            )

        # 3. Validate schema
        if not isinstance(body, dict):
            return JSONResponse(
                {"error": "validation_error", "detail": "Request body must be a JSON object"},
                status_code=400,
            )

        work_type = body.get("type")
        if not work_type or not isinstance(work_type, str):
            return JSONResponse(
                {"error": "validation_error", "detail": "Field 'type' is required and must be a non-empty string"},
                status_code=400,
            )

        payload = body.get("payload", {})
        if not isinstance(payload, dict):
            return JSONResponse(
                {"error": "validation_error", "detail": "Field 'payload' must be an object"},
                status_code=400,
            )

        correlation_id = body.get("correlation_id")

        # 4. Generate work ID
        work_id = str(uuid.uuid4())

        # 5. Build summary for events (no secrets — only type + correlation_id)
        summary = f"type={work_type}"
        if correlation_id:
            summary += f" correlation_id={correlation_id}"

        # 6. Emit work_received
        self._emitter.emit(
            type="work_received",
            tool="runtime",
            input_summary=summary,
            output_summary=None,
            duration_ms=None,
            success=None,
            metadata={"work_id": work_id},
        )

        # 7. Stub: no execution — immediately emit work_completed
        self._emitter.emit(
            type="work_completed",
            tool="runtime",
            input_summary=summary,
            output_summary=f"work_id={work_id} (stub — no execution)",
            duration_ms=0,
            success=True,
            metadata={"work_id": work_id},
        )

        # 8. Return ack
        return JSONResponse({
            "accepted": True,
            "work_id": work_id,
            "type": work_type,
        })

    def _check_auth(self, request: Request) -> bool:
        """Validate Bearer token against WORK_TOKEN."""
        if not self._work_token:
            return False

        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            return False

        token = auth_header[7:]  # len("Bearer ") == 7
        return token == self._work_token
