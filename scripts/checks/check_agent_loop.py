#!/usr/bin/env python3
"""Advisory agent-loop checks for pull requests.

This check is intentionally non-blocking by default. Set AGENT_LOOP_STRICT=1
in the environment to fail on missing evidence.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def changed_files(base_ref: str) -> list[str]:
    # Ensure base ref is present locally in CI contexts.
    subprocess.run(
        ["git", "fetch", "--no-tags", "origin", base_ref],
        cwd=ROOT,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        out = run(["git", "diff", "--name-only", f"origin/{base_ref}...HEAD"])
    except subprocess.CalledProcessError:
        # Local fallback when origin/base isn't available.
        out = run(["git", "diff", "--name-only", "HEAD"])
    return [line.strip() for line in out.splitlines() if line.strip()]


def read_pr_body() -> str:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        return ""

    try:
        data = json.loads(Path(event_path).read_text(encoding="utf-8"))
    except Exception:
        return ""

    pr = data.get("pull_request") or {}
    body = pr.get("body")
    return body or ""


def classify(files: list[str]) -> dict[str, bool]:
    ui = any(
        f.startswith("services/ui/")
        or f.startswith("platform/auth/keycloak/themes/")
        or f.endswith((".tsx", ".jsx", ".css", ".scss"))
        for f in files
    )
    api = any(f.startswith("services/api/") or f.startswith("services/mcp/") for f in files)
    infra = any(
        f.startswith("deploy/")
        or f.startswith("platform/")
        or (f.startswith("scripts/") and f.endswith(".sh"))
        for f in files
    )
    docs_only = bool(files) and all(f.endswith(".md") for f in files)

    return {
        "ui": ui,
        "api": api,
        "infra": infra,
        "docs_only": docs_only,
    }


def has_any_token(text: str, tokens: list[str]) -> bool:
    lower = text.lower()
    return any(token in lower for token in tokens)


def main() -> int:
    base_ref = os.environ.get("GITHUB_BASE_REF") or "main"
    strict = os.environ.get("AGENT_LOOP_STRICT") == "1"

    files = changed_files(base_ref)
    body = read_pr_body()
    types = classify(files)

    warnings: list[str] = []
    # Enforced warnings only block merges in strict mode (infra-gate).
    # Advisory warnings are always informational.
    enforced: list[str] = []

    if not files:
        warnings.append("No changed files detected from git diff (origin/base...HEAD).")

    if not re.search(r"\b[A-Z]{2,}-\d+\b", body) and "linear.app" not in body:
        warnings.append("Missing Linear reference in PR body (e.g. AI-123 or linear.app issue URL).")

    if "test plan" not in body.lower():
        warnings.append("Missing 'Test plan' section in PR body.")

    if types["ui"] and not has_any_token(body, ["playwright", "screenshot", "visual", "ui test"]):
        warnings.append("UI-related changes detected, but no Playwright/screenshot evidence found in PR body.")

    if types["api"] and not has_any_token(body, ["pytest", "npm test", "api test", "curl"]):
        warnings.append("API-related changes detected, but no API validation evidence found in PR body.")

    if types["infra"] and not has_any_token(body, ["deploy", "gh run", "workflow", "health"]):
        warnings.append("Infra-related changes detected, but no deploy/workflow/health evidence found in PR body.")

    # Infra PRs must include structured sections for safety review.
    # These are enforced (block merge) when AGENT_LOOP_STRICT=1.
    if types["infra"] and not types["docs_only"]:
        required_sections = ["plan", "risks", "rollback", "validation evidence"]
        body_lower = body.lower()
        for section in required_sections:
            # Match ## or ### headings
            if f"## {section}" not in body_lower and f"### {section}" not in body_lower:
                msg = (
                    f"Infra changes detected but PR body is missing a '{section.title()}' section "
                    f"(expected '## {section.title()}' or '### {section.title()}')."
                )
                warnings.append(msg)
                enforced.append(msg)

    header = "## Agent Loop Gate (Advisory)"
    lines = [header, "", f"- Base ref: `{base_ref}`", f"- Changed files: `{len(files)}`"]
    if types["docs_only"]:
        lines.append("- Change type: docs-only")
    else:
        active = [k for k, v in types.items() if v and k != "docs_only"]
        lines.append(f"- Change type flags: `{', '.join(active) if active else 'none'}`")

    if warnings:
        lines.append("")
        lines.append("### Warnings")
        for w in warnings:
            lines.append(f"- {w}")
    else:
        lines.append("")
        lines.append("- No warnings detected.")

    report = "\n".join(lines)
    print(report)

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(report + "\n")

    # Strict mode only fails on enforced warnings (infra section requirements),
    # not on general advisory warnings like missing Linear references.
    if enforced and strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
