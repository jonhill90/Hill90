"""Tests for scripts/checks/check_pr_body_h_prefix.py

Positive-controlled per this repo's own convention: show the check failing
on the exact defect it exists to catch, and show it passing on both the
correct syntax and on the prose usage it must NOT flag, since a check that
banned 'h#NNN' outright would make people stop using this repo's own
convention in the one place it is fine.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_pr_body_h_prefix.py"


def _run(body: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, PR_BODY=body)
    return subprocess.run(
        ["python3", str(SCRIPT)], capture_output=True, text=True, env=env
    )


def test_the_actual_defect_closes_h_prefix_fails():
    """THE ASSERTION THAT MATTERS: this is the exact live defect (h#786, h#844)."""
    result = _run("Closes h#844.\n\n## What was verified\n...")
    assert result.returncode == 1
    assert "FAILED" in result.stdout
    assert "'Closes h#844'" in result.stdout
    assert "write 'Closes #844' instead" in result.stdout


def test_correct_syntax_passes():
    """CONTROL: the fix for the defect above must itself be accepted."""
    result = _run("Closes #844.\n\n## What was verified\n...")
    assert result.returncode == 0
    assert "passed" in result.stdout


def test_h_prefix_in_prose_without_a_closing_keyword_passes():
    """CONTROL: this repo's own normal convention must not be banned.

    A check that flagged every 'h#NNN' anywhere would make people stop using
    this repo's own convention in prose, where nothing is broken.
    """
    result = _run(
        "Split out of #791. h#844's fix touches the same block as h#850's "
        "own review comment. See h#720 for the related minio decision."
    )
    assert result.returncode == 0
    assert "passed" in result.stdout


def test_other_closing_keyword_variants_are_all_caught():
    for text in [
        "Closed h#1.",
        "Fix h#2.",
        "Fixes h#3.",
        "Fixed h#4.",
        "Resolve h#5.",
        "Resolves h#6.",
        "Resolved h#7.",
        "Close: h#8.",
    ]:
        result = _run(text)
        assert result.returncode == 1, f"expected failure for {text!r}"


def test_closing_keyword_across_a_paragraph_break_is_not_a_false_positive():
    """A heading that happens to contain a keyword must not reach across a
    blank line to an unrelated 'h#NNN' mention many lines later."""
    result = _run(
        "Closes #746.\n\n## What this fixes\n\nh#746's top-ranked finding was..."
    )
    assert result.returncode == 0
    assert "passed" in result.stdout


def test_empty_body_passes():
    result = _run("")
    assert result.returncode == 0
    assert "passed" in result.stdout
