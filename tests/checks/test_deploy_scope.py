"""Deploy scope contract tests.

Validates that deploy.yml trigger paths and dorny/paths-filter filters
are consistent and correctly scoped. Three test layers:

  L1 — Trigger paths: which file changes cause the workflow to run at all.
  L2 — Dorny filters: which services each file path activates.
  L3 — Invariants: trigger paths and dorny filters are consistent.
"""

from __future__ import annotations

from fnmatch import fnmatch
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_YML = ROOT / ".github" / "workflows" / "deploy.yml"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_deploy_config() -> dict:
    """Load and parse deploy.yml."""
    return yaml.safe_load(DEPLOY_YML.read_text(encoding="utf-8"))


def _get_trigger_paths(config: dict) -> list[str]:
    """Extract on.push.paths from deploy.yml.

    PyYAML parses the YAML key ``on:`` as boolean True, so we look up
    both ``"on"`` and ``True`` to handle either parser behaviour.
    """
    on_block = config.get("on") or config.get(True)
    return on_block["push"]["paths"]


def _get_dorny_filters(config: dict) -> dict[str, list[str]]:
    """Extract dorny/paths-filter filters as {service: [patterns]}."""
    raw = config["jobs"]["changes"]["steps"][1]["with"]["filters"]
    return yaml.safe_load(raw)


def _matches_any(filepath: str, patterns: list[str]) -> bool:
    """Check if a filepath matches any glob pattern."""
    for pattern in patterns:
        if fnmatch(filepath, pattern):
            return True
        # Handle ** patterns: fnmatch doesn't natively handle ** across dirs,
        # but for our patterns it works because ** matches any sequence.
        if "**" in pattern:
            prefix = pattern.split("**")[0]
            if filepath.startswith(prefix):
                return True
    return False


def _services_for_path(filepath: str, dorny: dict[str, list[str]]) -> set[str]:
    """Return the set of services triggered by a filepath."""
    return {
        service
        for service, patterns in dorny.items()
        if _matches_any(filepath, patterns)
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def deploy_config():
    return _load_deploy_config()


@pytest.fixture(scope="module")
def trigger_paths(deploy_config):
    return _get_trigger_paths(deploy_config)


@pytest.fixture(scope="module")
def dorny_filters(deploy_config):
    return _get_dorny_filters(deploy_config)


# ---------------------------------------------------------------------------
# L2: Dorny filter tests — which services each path activates
# ---------------------------------------------------------------------------


class TestDornyFilters:
    """L2: Verify dorny filter routing for each service."""

    def test_api_change_triggers_only_api(self, dorny_filters):
        services = _services_for_path("services/api/src/index.ts", dorny_filters)
        assert services == {"api"}

    def test_ui_change_triggers_only_ui(self, dorny_filters):
        services = _services_for_path("services/ui/src/App.tsx", dorny_filters)
        assert services == {"ui"}

    def test_mcp_change_triggers_only_mcp(self, dorny_filters):
        services = _services_for_path("services/mcp/src/main.py", dorny_filters)
        assert services == {"mcp"}

    def test_auth_change_triggers_only_auth(self, dorny_filters):
        services = _services_for_path(
            "platform/auth/keycloak/themes/hill90/login/theme.properties",
            dorny_filters,
        )
        assert services == {"auth"}

    def test_observability_change_triggers_only_observability(self, dorny_filters):
        services = _services_for_path(
            "platform/observability/prometheus/prometheus.yml", dorny_filters
        )
        assert services == {"observability"}

    def test_db_compose_triggers_only_db(self, dorny_filters):
        services = _services_for_path(
            "deploy/compose/prod/docker-compose.db.yml", dorny_filters
        )
        assert services == {"db"}

    def test_infra_compose_triggers_no_services(self, dorny_filters):
        services = _services_for_path(
            "deploy/compose/prod/docker-compose.infra.yml", dorny_filters
        )
        assert services == set()

    def test_edge_config_triggers_no_services(self, dorny_filters):
        services = _services_for_path(
            "platform/edge/traefik/traefik.yml", dorny_filters
        )
        assert services == set()

    def test_readme_triggers_no_services(self, dorny_filters):
        services = _services_for_path("README.md", dorny_filters)
        assert services == set()

    def test_agentsmd_triggers_no_services(self, dorny_filters):
        services = _services_for_path("AGENTS.md", dorny_filters)
        assert services == set()


# ---------------------------------------------------------------------------
# L1: Trigger path tests — which paths cause the workflow to fire
# ---------------------------------------------------------------------------


class TestTriggerPaths:
    """L1: Verify trigger path inclusion and exclusion."""

    def test_trigger_paths_exact_list(self, trigger_paths):
        """Trigger paths must match the expected set exactly.

        This is the strictest L1 gate: any addition or removal of trigger
        paths must be reflected here, preventing silent scope creep.
        """
        expected = sorted([
            "services/api/**",
            "services/ai/**",
            "services/mcp/**",
            "services/ui/**",
            "platform/auth/keycloak/**",
            "platform/data/postgres/**",
            "platform/observability/**",
            "deploy/compose/prod/docker-compose.db.yml",
            "deploy/compose/prod/docker-compose.minio.yml",
            "deploy/compose/prod/docker-compose.auth.yml",
            "deploy/compose/prod/docker-compose.api.yml",
            "deploy/compose/prod/docker-compose.ai.yml",
            "deploy/compose/prod/docker-compose.mcp.yml",
            "deploy/compose/prod/docker-compose.ui.yml",
            "deploy/compose/prod/docker-compose.observability.yml",
        ])
        assert sorted(trigger_paths) == expected

    def test_trigger_paths_include_api(self, trigger_paths):
        assert _matches_any("services/api/src/index.ts", trigger_paths)

    def test_trigger_paths_include_auth_platform(self, trigger_paths):
        assert _matches_any(
            "platform/auth/keycloak/themes/hill90/login/theme.properties",
            trigger_paths,
        )

    def test_trigger_paths_exclude_unknown_service(self, trigger_paths):
        assert not _matches_any(
            "services/newsvc/src/main.ts", trigger_paths
        )

    def test_trigger_paths_exclude_unknown_platform_data(self, trigger_paths):
        assert not _matches_any(
            "platform/data/redis/redis.conf", trigger_paths
        )

    def test_trigger_paths_exclude_infra(self, trigger_paths):
        assert not _matches_any(
            "deploy/compose/prod/docker-compose.infra.yml", trigger_paths
        )

    def test_trigger_paths_exclude_edge(self, trigger_paths):
        assert not _matches_any("platform/edge/traefik/traefik.yml", trigger_paths)

    def test_trigger_paths_exclude_agentbox(self, trigger_paths):
        assert not _matches_any("platform/agentbox/agents/coder/agent.yml", trigger_paths)

    def test_trigger_paths_exclude_deploy_scripts(self, trigger_paths):
        assert not _matches_any("scripts/deploy.sh", trigger_paths)

    def test_trigger_paths_exclude_readme(self, trigger_paths):
        assert not _matches_any("README.md", trigger_paths)


# ---------------------------------------------------------------------------
# L3: Invariant tests — trigger and dorny consistency
# ---------------------------------------------------------------------------


class TestInvariants:
    """L3: Verify structural consistency between triggers and filters."""

    def test_dorny_paths_subset_of_trigger_paths(self, trigger_paths, dorny_filters):
        """Every path that dorny matches must also be reachable by trigger paths.

        If a dorny filter matches a file but the trigger paths don't include it,
        the workflow never fires and that filter is dead code.
        """
        violations = []
        # Collect all dorny patterns and generate representative paths.
        for service, patterns in dorny_filters.items():
            for pattern in patterns:
                # Generate a representative file path from the pattern.
                representative = pattern.replace("**", "subdir/file.txt")
                if not _matches_any(representative, trigger_paths):
                    violations.append(
                        f"Dorny filter '{pattern}' (service: {service}) "
                        f"not reachable by trigger paths"
                    )
        assert not violations, "\n".join(violations)

    def test_no_trigger_path_orphans(self, trigger_paths, dorny_filters):
        """Every trigger path must overlap with at least one dorny filter.

        If a trigger path has zero overlap with dorny filters, the workflow
        fires but no service deploys — a zero-job noise run.

        We check overlap by verifying that at least one dorny filter's
        representative file also matches the trigger path.
        """
        all_dorny_representatives = []
        for patterns in dorny_filters.values():
            for pattern in patterns:
                rep = pattern.replace("**", "subdir/file.txt")
                all_dorny_representatives.append((rep, pattern))

        orphans = []
        for trigger_path in trigger_paths:
            # A trigger path is NOT an orphan if any dorny representative
            # matches it (meaning the trigger path covers that dorny filter).
            has_overlap = any(
                _matches_any(rep, [trigger_path])
                for rep, _ in all_dorny_representatives
            )
            if not has_overlap:
                orphans.append(
                    f"Trigger path '{trigger_path}' has no overlap with any dorny filter"
                )
        assert not orphans, "\n".join(orphans)
