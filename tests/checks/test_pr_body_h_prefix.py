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


def test_quoted_defect_inside_inline_backticks_passes():
    """CONTROL: discussing the bad pattern is not using it."""
    result = _run("This check fails on `Closes h#123` in a PR body.")
    assert result.returncode == 0
    assert "passed" in result.stdout


def test_quoted_defect_inside_a_fenced_block_passes():
    """CONTROL: same as above, fenced instead of inline."""
    body = (
        "Positive control:\n\n"
        "```\n"
        "Closes h#123\n"
        "```\n\n"
        "That's the failing case."
    )
    result = _run(body)
    assert result.returncode == 0
    assert "passed" in result.stdout


def test_bare_unquoted_defect_still_fails_even_with_code_stripping():
    """THE ARM THAT KEEPS THE CHECK HONEST: code-stripping must not become
    an escape hatch. A real, unquoted, un-fenced 'Closes h#NNN' still fails."""
    result = _run("Closes h#844.\n\nSome unrelated body text.")
    assert result.returncode == 1
    assert "FAILED" in result.stdout
    assert "'Closes h#844'" in result.stdout


def test_self_referential_case_prose_explanation_plus_backtick_quote_passes():
    """REGRESSION: this is h#864's own PR body shape — the exact false
    positive CI caught on itself. A body that explains the h#-prefix trap in
    prose AND quotes the bad pattern in backticks as evidence must pass."""
    body = (
        "GitHub does not parse 'h#NNN' as an issue reference — only '#NNN' "
        "closes an issue.\n\n"
        "## Positive control\n\n"
        "```\n"
        "=== FAILING: the actual live defect shape ===\n"
        "PR body h#-prefix check FAILED.\n\n"
        "  'Closes h#844' -> write 'Closes #844' instead\n"
        "exit: 1\n\n"
        "=== PASSING: correct syntax ===\n"
        "PR body h#-prefix check passed: no closing keyword followed by "
        "'h#NNN' found (12 chars scanned).\n"
        "exit: 0\n"
        "```\n\n"
        "This repo prefixes issue references with 'h#' in prose "
        "(e.g. \"h#844's fix\"), which reads fine and is fine."
    )
    result = _run(body)
    assert result.returncode == 0
    assert "passed" in result.stdout
