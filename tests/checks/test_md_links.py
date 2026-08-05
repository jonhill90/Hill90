"""Tests for scripts/checks/check_md_links.py

h#734: SCAN_ROOTS is resolved from the script's own file location
(Path(__file__).resolve().parents[2]), not from cwd, so reproducing the
"nothing to scan" case needs a copy of the script placed under an isolated
tree that genuinely lacks README.md / CONTRIBUTING.md / docs / .github —
not just a different working directory.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_md_links.py"


def _run_in(tree: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(tree / "scripts" / "checks" / "check_md_links.py")],
        cwd=tree,
        capture_output=True,
        text=True,
    )


def _isolated_tree(tmp_path: Path) -> Path:
    """A tree shaped like the repo root, with the real script copied in."""
    (tmp_path / "scripts" / "checks").mkdir(parents=True)
    shutil.copy(SCRIPT, tmp_path / "scripts" / "checks" / "check_md_links.py")
    return tmp_path


def test_real_repo_passes():
    """CONTROL: the real repo has no missing local links today."""
    result = subprocess.run(
        ["python3", str(SCRIPT)], capture_output=True, text=True
    )
    assert result.returncode == 0
    assert "passed" in result.stdout
    # Not vacuous: the real repo has real docs to scan.
    assert "files scanned" in result.stdout


def test_none_of_the_scan_roots_existing_refuses_rather_than_passing(tmp_path):
    """THE ASSERTION THAT MATTERS: no scan roots present -> CANNOT DETERMINE, not PASS."""
    tree = _isolated_tree(tmp_path)
    result = _run_in(tree)
    assert result.returncode == 2
    assert "CANNOT DETERMINE" in result.stdout
    assert "passed" not in result.stdout


def test_a_real_broken_link_is_still_caught(tmp_path):
    """CONTROL: detection itself is unaffected by the guard."""
    tree = _isolated_tree(tmp_path)
    docs = tree / "docs"
    docs.mkdir()
    (docs / "test.md").write_text("[broken](./does-not-exist.md)\n", encoding="utf-8")

    result = _run_in(tree)
    assert result.returncode == 1
    assert "does-not-exist.md" in result.stdout


def test_a_real_working_link_passes_and_reports_a_nonzero_scan_count(tmp_path):
    """CONTROL: a genuinely clean, non-empty scan is unaffected — still PASS."""
    tree = _isolated_tree(tmp_path)
    docs = tree / "docs"
    docs.mkdir()
    (docs / "a.md").write_text("[ok](./b.md)\n", encoding="utf-8")
    (docs / "b.md").write_text("nothing here\n", encoding="utf-8")

    result = _run_in(tree)
    assert result.returncode == 0
    assert "2 files scanned" in result.stdout


def test_exit_codes_for_nothing_to_scan_vs_clean_vs_broken_are_three_distinct_states(
    tmp_path,
):
    empty_tree = _isolated_tree(tmp_path / "empty")
    empty_status = _run_in(empty_tree).returncode

    clean_tree = _isolated_tree(tmp_path / "clean")
    (clean_tree / "docs").mkdir()
    (clean_tree / "docs" / "a.md").write_text("nothing here\n", encoding="utf-8")
    clean_status = _run_in(clean_tree).returncode

    broken_tree = _isolated_tree(tmp_path / "broken")
    (broken_tree / "docs").mkdir()
    (broken_tree / "docs" / "a.md").write_text(
        "[broken](./nope.md)\n", encoding="utf-8"
    )
    broken_status = _run_in(broken_tree).returncode

    assert empty_status == 2
    assert clean_status == 0
    assert broken_status == 1
