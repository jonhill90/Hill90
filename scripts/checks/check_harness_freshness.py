#!/usr/bin/env python3
"""Enforce harness freshness invariants for AGENTS/docs linkage."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT / "AGENTS.md"
MAX_AGENTS_LINES = 180

REQUIRED_AGENTS_LINKS = [
    ".github/docs/harness-reference.md",
    ".github/docs/contribution-workflow.md",
    ".claude/references/task-management.md",
]

REQUIRED_SYMLINKS = {
    ROOT / "CLAUDE.md": "AGENTS.md",
    ROOT / ".github" / "copilot-instructions.md": "../AGENTS.md",
    ROOT / ".claude" / "references" / "contribution-workflow.md": "../../.github/docs/contribution-workflow.md",
    ROOT / ".claude" / "references" / "harness-reference.md": "../../.github/docs/harness-reference.md",
}


def fail(msg: str) -> None:
    print(f"[FAIL] {msg}")


def main() -> int:
    failed = False

    if not AGENTS.exists():
        fail("AGENTS.md is missing")
        return 1

    agents_text = AGENTS.read_text(encoding="utf-8", errors="ignore")
    agents_lines = agents_text.count("\n") + 1
    if agents_lines > MAX_AGENTS_LINES:
        fail(f"AGENTS.md too long: {agents_lines} lines (max {MAX_AGENTS_LINES})")
        failed = True

    for link in REQUIRED_AGENTS_LINKS:
        if link not in agents_text:
            fail(f"AGENTS.md missing required reference: {link}")
            failed = True
        target = ROOT / link
        if not target.exists():
            fail(f"Required reference target missing: {link}")
            failed = True

    for path, expected in REQUIRED_SYMLINKS.items():
        if not path.exists():
            fail(f"Required path missing: {path.relative_to(ROOT)}")
            failed = True
            continue

        if not path.is_symlink():
            fail(f"Expected symlink but found regular file: {path.relative_to(ROOT)}")
            failed = True
            continue

        actual = os.readlink(path)
        if actual != expected:
            fail(
                f"Symlink target mismatch for {path.relative_to(ROOT)}: "
                f"expected '{expected}', got '{actual}'"
            )
            failed = True

    if failed:
        return 1

    print("Harness freshness check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
