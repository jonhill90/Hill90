"""Tests for scripts/checks/check_container_profile_ceilings.py (Hill90#845).

Two layers, deliberately separate:

1. `violations` — the pure comparison against a fabricated fixture. No live
   host, no database, no hill90-app checkout. Fast, and where the
   cannot-determine-vs-pass discrimination is easiest to pin precisely.

2. The CLI, invoked as a subprocess with the real live container_profiles
   rows (Verified 2026-08-06 against production Postgres) as a fixture —
   proving the exit codes and messages the caller (deploy-drift.yml)
   actually depends on, not just the internal function's return value.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "checks" / "check_container_profile_ceilings.py"

sys.path.insert(0, str(ROOT / "scripts" / "checks"))
from check_container_profile_ceilings import violations, parse_cpus, parse_mem_limit  # noqa: E402

# The real, live rows (container_profiles migrations 032/039), Verified
# 2026-08-06 against production Postgres.
LIVE_PROFILES = [
    {"name": "standard", "default_cpus": "1.0", "default_mem_limit": "1g", "default_pids_limit": 200},
    {"name": "browser", "default_cpus": "2.0", "default_mem_limit": "2g", "default_pids_limit": 300},
    {"name": "monitor", "default_cpus": "0.5", "default_mem_limit": "256m", "default_pids_limit": 100},
]
MAX_CPUS = 4
MAX_MEM_BYTES = 16761118720
MAX_PIDS_LIMIT = 300


class TestParsers:
    def test_parse_cpus_accepts_a_plain_decimal(self):
        assert parse_cpus("2.0") == 2.0

    def test_parse_cpus_rejects_garbage_without_raising(self):
        assert parse_cpus("unlimited") is None
        assert parse_cpus(None) is None
        assert parse_cpus(9999) is None  # not a string at all

    def test_parse_mem_limit_units(self):
        assert parse_mem_limit("1g") == 1024 ** 3
        assert parse_mem_limit("256m") == 256 * 1024 ** 2
        assert parse_mem_limit("1024") == 1024

    def test_parse_mem_limit_rejects_garbage_without_raising(self):
        assert parse_mem_limit("lots") is None
        assert parse_mem_limit(None) is None


class TestViolationsPureLogic:
    def test_the_real_current_rows_violate_nothing(self):
        assert violations(LIVE_PROFILES, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT) == []

    # THE POSITIVE CONTROL: raise ONE bound in the fixture past the ceiling
    # and confirm this specific function is what catches it — named, and
    # only that field.
    def test_POSITIVE_CONTROL_a_profile_default_pids_limit_raised_past_the_ceiling_is_caught(self):
        mutated = [dict(p) for p in LIVE_PROFILES]
        mutated[1]["default_pids_limit"] = 301  # browser

        found = violations(mutated, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT)

        assert len(found) == 1
        assert found[0]["profile"] == "browser"
        assert found[0]["field"] == "default_pids_limit"
        assert "301" in found[0]["detail"]
        assert "300" in found[0]["detail"]

    def test_TWIN_exactly_at_the_ceiling_is_not_a_violation(self):
        mutated = [dict(p) for p in LIVE_PROFILES]
        mutated[1]["default_pids_limit"] = 300  # already there, but explicit
        assert violations(mutated, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT) == []

    def test_default_cpus_over_ceiling_is_independent_of_the_other_two_fields(self):
        mutated = [dict(p) for p in LIVE_PROFILES]
        mutated[1]["default_cpus"] = "5.0"
        found = violations(mutated, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT)
        assert len(found) == 1
        assert found[0]["field"] == "default_cpus"

    def test_default_mem_limit_over_ceiling_is_independent_of_the_other_two_fields(self):
        mutated = [dict(p) for p in LIVE_PROFILES]
        mutated[1]["default_mem_limit"] = "9999g"
        found = violations(mutated, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT)
        assert len(found) == 1
        assert found[0]["field"] == "default_mem_limit"

    def test_multiple_violated_profiles_are_all_reported(self):
        mutated = [{**p, "default_pids_limit": 9999} for p in LIVE_PROFILES]
        found = violations(mutated, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT)
        assert sorted(v["profile"] for v in found) == ["browser", "monitor", "standard"]

    def test_an_unparseable_field_is_a_violation_not_a_silent_skip(self):
        mutated = [dict(p) for p in LIVE_PROFILES]
        mutated[0]["default_cpus"] = "not-a-number"
        found = violations(mutated, MAX_CPUS, MAX_MEM_BYTES, MAX_PIDS_LIMIT)
        assert any(v["field"] == "default_cpus" and "unparseable" in v["detail"] for v in found)


def run_cli(profiles_json: str, max_cpus="4", max_mem_bytes="16761118720", max_pids_limit="300") -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable, str(SCRIPT),
            "--max-cpus", max_cpus,
            "--max-mem-bytes", max_mem_bytes,
            "--max-pids-limit", max_pids_limit,
            "--profiles-json", profiles_json,
        ],
        capture_output=True, text=True,
    )


class TestCLI:
    def test_the_real_current_rows_exit_0(self):
        result = run_cli(json.dumps(LIVE_PROFILES))
        assert result.returncode == 0, result.stderr
        assert "No violations" in result.stdout

    def test_POSITIVE_CONTROL_a_genuine_violation_exits_1_and_names_it(self):
        mutated = [dict(p) for p in LIVE_PROFILES]
        mutated[1]["default_pids_limit"] = 301
        result = run_cli(json.dumps(mutated))
        assert result.returncode == 1
        assert "browser.default_pids_limit" in result.stderr
        assert "301" in result.stderr

    # THE CANNOT-DETERMINE ARM, distinct from a pass — the reason this issue
    # exists. Each of these must be exit 2, never 0.
    def test_the_sentinel_ERROR_string_from_a_failed_live_read_is_CANNOT_DETERMINE(self):
        result = run_cli("ERROR")
        assert result.returncode == 2
        assert "CANNOT DETERMINE" in result.stderr

    def test_unparseable_json_is_CANNOT_DETERMINE(self):
        result = run_cli("{not valid json")
        assert result.returncode == 2
        assert "CANNOT DETERMINE" in result.stderr

    def test_an_empty_list_is_CANNOT_DETERMINE_not_a_pass(self):
        # THE TRAP THIS ISSUE IS NAMED FOR: zero rows must never read as
        # "zero violations". At least `standard` always exists.
        result = run_cli("[]")
        assert result.returncode == 2
        assert "CANNOT DETERMINE" in result.stderr
        assert "zero rows" in result.stderr

    def test_a_json_object_instead_of_a_list_is_CANNOT_DETERMINE(self):
        result = run_cli(json.dumps({"not": "a list"}))
        assert result.returncode == 2
