#!/usr/bin/env python3
"""Advisory closed-loop planning check for pull requests.

Validates that non-trivial PRs include all 9 closed-loop plan sections,
either in the PR body or in changed .claude/plans/*.md files.

This check is intentionally non-blocking by default. Set
PLAN_CLOSED_LOOP_STRICT=1 in the environment to fail on missing evidence.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

TRIVIAL_THRESHOLD = 3

# Each entry: section key -> compiled regex pattern.
# Patterns are anchored to heading start to avoid false passes from
# headings like "Next steps", "CI workflow", "Done", etc.
REQUIRED_SECTIONS: dict[str, re.Pattern[str]] = {
    "goal": re.compile(
        r"^#{2,3}\s+(?:goal|signal|goal\s*/\s*signal|objective)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "scope": re.compile(
        r"^#{2,3}\s+scope",
        re.IGNORECASE | re.MULTILINE,
    ),
    "tdd": re.compile(
        r"^#{2,3}\s+(?:tdd|test\s+matrix)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "steps": re.compile(
        r"^#{2,3}\s+(?:implementation\s+steps|approach)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "verification": re.compile(
        r"^#{2,3}\s+(?:verification\s+matrix|verification\s+checklist|verification)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "ci-gates": re.compile(
        r"^#{2,3}\s+(?:ci\s*/\s*drift|ci\s+gates|drift\s+gates)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "risks": re.compile(
        r"^#{2,3}\s+(?:risks?(?:\s|$)|risks?\s*&|risks?\s+and\s+mitigations)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "definition-of-done": re.compile(
        r"^#{2,3}\s+(?:definition\s+of\s+done|done\s+criteria)",
        re.IGNORECASE | re.MULTILINE,
    ),
    "stop-conditions": re.compile(
        r"^#{2,3}\s+(?:stop\s+conditions|out[- ]of[- ]scope)",
        re.IGNORECASE | re.MULTILINE,
    ),
}


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def changed_files(base_ref: str) -> list[str]:
    """Get list of changed files, with test override support."""
    override = os.environ.get("_CHANGED_FILES_OVERRIDE")
    if override is not None:
        if not override:
            return []
        path = Path(override)
        if not path.exists() or path.stat().st_size == 0:
            return []
        return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

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
    docs_only = bool(files) and all(f.endswith(".md") for f in files)
    return {"docs_only": docs_only}


def get_plan_file_content(files: list[str]) -> str:
    """Read changed plan file content, with test override support."""
    override = os.environ.get("_PLAN_FILES_OVERRIDE")
    if override is not None:
        path = Path(override)
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    parts = []
    for f in files:
        if f.startswith(".claude/plans/") and f.endswith(".md"):
            full = ROOT / f
            if full.exists():
                parts.append(full.read_text(encoding="utf-8"))
    return "\n".join(parts)


def check_sections(text: str) -> list[str]:
    """Return list of missing section keys."""
    missing = []
    for key, pattern in REQUIRED_SECTIONS.items():
        if not pattern.search(text):
            missing.append(key)
    return missing


def main() -> int:
    base_ref = os.environ.get("GITHUB_BASE_REF") or "main"
    strict = os.environ.get("PLAN_CLOSED_LOOP_STRICT") == "1"

    files = changed_files(base_ref)
    body = read_pr_body()
    types = classify(files)

    # Skip for docs-only PRs.
    if types["docs_only"]:
        print("Closed-loop plan check: skipped (docs-only PR).")
        _write_summary("Closed-loop plan check: skipped (docs-only PR).")
        return 0

    # Skip for trivial PRs (fewer than TRIVIAL_THRESHOLD files).
    if len(files) < TRIVIAL_THRESHOLD:
        print(f"Closed-loop plan check: skipped ({len(files)} files < {TRIVIAL_THRESHOLD} threshold).")
        _write_summary(f"Closed-loop plan check: skipped ({len(files)} files < {TRIVIAL_THRESHOLD} threshold).")
        return 0

    # Collect text to check: PR body + changed plan file content.
    plan_content = get_plan_file_content(files)
    combined_text = body + "\n" + plan_content

    missing = check_sections(combined_text)

    warnings: list[str] = []
    for key in missing:
        warnings.append(f"[WARN] Missing closed-loop section: {key}")

    # Build report.
    header = "## Closed-Loop Plan Check (Advisory)"
    lines = [header, "", f"- Changed files: `{len(files)}`"]

    if warnings:
        lines.append("")
        lines.append("### Warnings")
        for w in warnings:
            lines.append(f"- {w}")
            print(w)
    else:
        lines.append("")
        lines.append("All 9 closed-loop plan sections found.")
        print("Closed-loop plan check: all sections present.")

    report = "\n".join(lines)
    _write_summary(report)

    if missing and strict:
        return 1
    return 0


def _write_summary(text: str) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


if __name__ == "__main__":
    sys.exit(main())
