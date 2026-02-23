"""Tests for scripts/checks/check_plan_closed_loop.py

Validates closed-loop planning evidence in PR bodies and plan files.
Tests follow the subprocess pattern used by existing BATS tests.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_plan_closed_loop.py"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

COMPLETE_PLAN = """
## Goal / Signal
We want to achieve X.

## Scope
In scope: A, B, C.

## TDD Matrix
| Requirement | Test |
|---|---|
| Foo | test_foo |

## Implementation Steps
1. Do this
2. Do that

## Verification Matrix
- [ ] Check A
- [ ] Check B

## CI / Drift Gates
Existing gates preserved.

## Risks & Mitigations
| Risk | Mitigation |
|---|---|
| X | Y |

## Definition of Done
- [ ] All tests pass

## Stop Conditions
Stop if X exceeds Y.
"""


def _run(
    env_overrides: dict[str, str] | None = None,
    pr_body: str = "",
    changed_files: list[str] | None = None,
    plan_file_content: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run the check script with controlled environment."""
    env = os.environ.copy()
    # Clear CI env vars that might leak from real environment.
    env.pop("GITHUB_EVENT_PATH", None)
    env.pop("GITHUB_BASE_REF", None)
    env.pop("GITHUB_STEP_SUMMARY", None)
    env.pop("PLAN_CLOSED_LOOP_STRICT", None)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)

        # Write event.json with PR body.
        event = {"pull_request": {"body": pr_body}}
        event_path = tmpdir_path / "event.json"
        event_path.write_text(json.dumps(event), encoding="utf-8")
        env["GITHUB_EVENT_PATH"] = str(event_path)

        # Write summary file path.
        summary_path = tmpdir_path / "summary.md"
        env["GITHUB_STEP_SUMMARY"] = str(summary_path)

        # Create a fake changed-files list if provided.
        if changed_files is not None:
            files_path = tmpdir_path / "changed_files.txt"
            files_path.write_text("\n".join(changed_files), encoding="utf-8")
            env["_CHANGED_FILES_OVERRIDE"] = str(files_path)

        # Write a plan file if provided.
        if plan_file_content is not None:
            plan_dir = tmpdir_path / "plans"
            plan_dir.mkdir()
            plan_file = plan_dir / "plan.md"
            plan_file.write_text(plan_file_content, encoding="utf-8")
            env["_PLAN_FILES_OVERRIDE"] = str(plan_file)

        if env_overrides:
            env.update(env_overrides)

        return subprocess.run(
            ["python3", str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            cwd=ROOT,
        )


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------


class TestAllSectionsPresent:
    def test_all_sections_present_passes(self):
        """Complete plan body with all 9 sections should pass with no warnings."""
        result = _run(
            pr_body=COMPLETE_PLAN,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout


class TestMissingSections:
    def test_missing_goal_warns(self):
        """Missing Goal/Signal section should produce a warning."""
        body = COMPLETE_PLAN.replace("## Goal / Signal", "## Removed")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout
        assert "goal" in result.stdout.lower()

    def test_missing_tdd_warns(self):
        """Missing TDD Matrix section should produce a warning."""
        body = COMPLETE_PLAN.replace("## TDD Matrix", "## Removed2")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout
        assert "tdd" in result.stdout.lower()

    def test_missing_scope_warns(self):
        """Missing Scope section should produce a warning."""
        body = COMPLETE_PLAN.replace("## Scope", "## Removed3")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout
        assert "scope" in result.stdout.lower()

    def test_missing_stop_warns(self):
        """Missing Stop Conditions section should produce a warning."""
        body = COMPLETE_PLAN.replace("## Stop Conditions", "## Removed4")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout
        assert "stop" in result.stdout.lower()

    def test_missing_dod_warns(self):
        """Missing Definition of Done section should produce a warning."""
        body = COMPLETE_PLAN.replace("## Definition of Done", "## Removed5")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout
        assert "definition" in result.stdout.lower() or "done" in result.stdout.lower()

    def test_multiple_missing_warns_all(self):
        """Multiple missing sections should produce a warning for each."""
        body = (
            COMPLETE_PLAN.replace("## Goal / Signal", "## Removed")
            .replace("## TDD Matrix", "## Removed2")
            .replace("## Risks & Mitigations", "## Removed3")
        )
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        warns = [line for line in result.stdout.splitlines() if "[WARN]" in line]
        assert len(warns) >= 3


class TestStrictMode:
    def test_strict_mode_fails_on_missing(self):
        """Strict mode should exit 1 when sections are missing."""
        body = COMPLETE_PLAN.replace("## Goal / Signal", "## Removed")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
            env_overrides={"PLAN_CLOSED_LOOP_STRICT": "1"},
        )
        assert result.returncode == 1

    def test_strict_mode_passes_when_complete(self):
        """Strict mode should exit 0 when all sections are present."""
        result = _run(
            pr_body=COMPLETE_PLAN,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
            env_overrides={"PLAN_CLOSED_LOOP_STRICT": "1"},
        )
        assert result.returncode == 0


class TestSkipConditions:
    def test_docs_only_pr_skips(self):
        """Docs-only PRs should skip the check entirely."""
        result = _run(
            pr_body="Just docs changes",
            changed_files=["README.md", "docs/guide.md"],
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout

    def test_trivial_pr_skips(self):
        """PRs with fewer than 3 changed files should skip."""
        result = _run(
            pr_body="Small fix",
            changed_files=["src/foo.py", "src/bar.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout


class TestPlanFiles:
    def test_changed_plan_file_validates(self):
        """A changed plan file with all sections should pass."""
        result = _run(
            pr_body="",
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
            plan_file_content=COMPLETE_PLAN,
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout

    def test_changed_plan_file_missing_sections_warns(self):
        """A changed plan file missing sections should warn."""
        result = _run(
            pr_body="",
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
            plan_file_content="## Goal / Signal\nSome goal.\n",
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout

    def test_unchanged_plan_files_ignored(self):
        """Historical plan files not in the diff should be ignored."""
        # No plan file override + no plan content in body = warns about missing sections.
        result = _run(
            pr_body="No plan here",
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout


class TestHeadingVariants:
    def test_heading_case_insensitive(self):
        """Headings should match case-insensitively."""
        body = COMPLETE_PLAN.replace("## Goal / Signal", "## goal / signal")
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout

    def test_h2_and_h3_headings_accepted(self):
        """Both ## and ### headings should be accepted."""
        body = COMPLETE_PLAN.replace("## Goal / Signal", "### Goal / Signal").replace(
            "## TDD Matrix", "### TDD Matrix"
        )
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout

    def test_alternative_heading_names(self):
        """Alternative heading names (Objective, Approach) should be accepted."""
        body = (
            COMPLETE_PLAN.replace("## Goal / Signal", "## Objective")
            .replace("## Implementation Steps", "## Approach")
            .replace("## Definition of Done", "## Done Criteria")
            .replace("## Stop Conditions", "## Out of Scope")
            .replace("## TDD Matrix", "## Test Matrix")
        )
        result = _run(
            pr_body=body,
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" not in result.stdout


class TestNoBodyNoPlanFiles:
    def test_no_body_no_plan_files_warns(self):
        """No PR body and no plan files should produce warnings."""
        result = _run(
            pr_body="",
            changed_files=["src/foo.py", "src/bar.py", "tests/test_foo.py"],
        )
        assert result.returncode == 0
        assert "[WARN]" in result.stdout


class TestGitHubStepSummary:
    def test_github_step_summary_written(self):
        """GITHUB_STEP_SUMMARY file should be written to."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            summary_path = tmpdir_path / "summary.md"
            event = {"pull_request": {"body": COMPLETE_PLAN}}
            event_path = tmpdir_path / "event.json"
            event_path.write_text(json.dumps(event), encoding="utf-8")

            env = os.environ.copy()
            env.pop("GITHUB_EVENT_PATH", None)
            env.pop("GITHUB_BASE_REF", None)
            env.pop("PLAN_CLOSED_LOOP_STRICT", None)
            env["GITHUB_EVENT_PATH"] = str(event_path)
            env["GITHUB_STEP_SUMMARY"] = str(summary_path)
            # Provide changed files so the check doesn't skip.
            files_path = tmpdir_path / "changed_files.txt"
            files_path.write_text(
                "src/foo.py\nsrc/bar.py\ntests/test_foo.py", encoding="utf-8"
            )
            env["_CHANGED_FILES_OVERRIDE"] = str(files_path)

            subprocess.run(
                ["python3", str(SCRIPT)],
                capture_output=True,
                text=True,
                env=env,
                cwd=ROOT,
            )

            assert summary_path.exists()
            content = summary_path.read_text(encoding="utf-8")
            assert "Closed-Loop" in content or "closed-loop" in content.lower()
