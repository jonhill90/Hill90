"""The edge middleware check must catch each failure it exists to catch.

A check that only ever passes is indistinguishable from no check. Each test here
mutates a COPY of the real tree into one specific broken state and asserts the check
fails on it, so the check's ability to fail is demonstrated rather than assumed.

The v3 rename case is the one that matters most: it is the failure this whole file
exists for, and it cannot be tested against the real tree because the real tree is
correct today.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CHECK = "scripts/checks/check_edge_middlewares.py"
MW = "platform/edge/dynamic/middlewares.yml"
INFRA = "deploy/compose/prod/docker-compose.infra.yml"


def run(tree: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(tree / CHECK)],
        capture_output=True, text=True, cwd=str(tree),
    )


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """A copy of the parts of the repo the check reads."""
    dst = tmp_path / "repo"
    for rel in (CHECK, MW, INFRA):
        (dst / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst / rel)
    # The check globs the compose dir; copy the rest so router chains are complete.
    for f in (ROOT / "deploy" / "compose" / "prod").glob("*.yml"):
        shutil.copy2(f, dst / "deploy" / "compose" / "prod" / f.name)
    return dst


def test_the_real_tree_passes(tree: Path) -> None:
    """Baseline. If this fails, every mutation test below proves nothing."""
    r = run(tree)
    assert r.returncode == 0, f"unmutated tree should pass:\n{r.stdout}\n{r.stderr}"
    assert "PASS" in r.stdout


def test_catches_v3_bump_without_rename(tree: Path) -> None:
    """THE case this file exists for: image bumped to v3, ipWhiteList left behind."""
    p = tree / INFRA
    p.write_text(p.read_text().replace("traefik:v2.11", "traefik:v3.1"))
    r = run(tree)
    assert r.returncode == 1
    assert "ipWhiteList" in r.stderr
    assert "v3" in r.stderr
    # The message must say what happens, not just that something is wrong.
    assert "no allowlist" in r.stderr.lower() or "silent" in r.stderr.lower()


def test_catches_v2_using_the_v3_name(tree: Path) -> None:
    """The mirror image: renamed too early, while still pinned at v2."""
    p = tree / MW
    p.write_text(p.read_text().replace("ipWhiteList:", "ipAllowList:"))
    r = run(tree)
    assert r.returncode == 1
    assert "ipAllowList" in r.stderr


def test_catches_a_reference_to_a_middleware_that_does_not_exist(tree: Path) -> None:
    """A router pointing at a name with no definition — Traefik loads it anyway."""
    p = tree / MW
    p.write_text(p.read_text().replace("    tailscale-only:", "    tailscale-onlyy:"))
    r = run(tree)
    assert r.returncode == 1
    assert "not defined" in r.stderr


def test_catches_an_allowlist_ordered_behind_an_authenticator(tree: Path) -> None:
    """The defect observed in production on 2026-07-31, reintroduced."""
    p = tree / INFRA
    p.write_text(p.read_text().replace(
        "${TRAEFIK_MIDDLEWARES:-tailscale-only@file,auth@file}",
        "${TRAEFIK_MIDDLEWARES:-auth@file,tailscale-only@file}",
    ))
    r = run(tree)
    assert r.returncode == 1
    assert "after auth" in r.stderr
    assert "credentials before being refused" in r.stderr


def test_does_not_pass_vacuously_when_definitions_are_missing(tree: Path) -> None:
    """An empty middlewares file must fail, not pass with nothing to check.

    Every 'is it defined' assertion is a negative, and negatives are satisfied by an
    empty set. This is the guard against the check quietly measuring nothing.
    """
    (tree / MW).write_text("http:\n  middlewares:\n")
    r = run(tree)
    assert r.returncode == 1
    assert "vacuously" in r.stderr or "not defined" in r.stderr


def test_inline_bodied_middlewares_are_recognised(tree: Path) -> None:
    """`compress: {}` is a complete definition and must not read as undefined.

    An earlier version of the parser required the type key to be alone on its line,
    so it silently dropped `compress`. Nothing referenced it, so nothing failed — the
    bug was found by counting parsed names against the file. If a router ever
    references it, a false 'not defined' failure would send someone hunting a
    non-existent typo.
    """
    r = run(tree)
    assert "compress" in r.stdout, f"compress should be parsed:\n{r.stdout}"
