#!/usr/bin/env python3
"""Keep the local/production configuration surface honest.

Adapted from check_env_surface.py in docker-infra-template, which solved this
problem first.

Hill90 runs the SAME compose files locally and in production; the differences
live in environment variables and in deploy/compose/overrides/local.*.yml. That
only stays true if something enforces it, so this check asserts three things:

  1. Every ${VAR} a compose file references is documented in .env.local.example
     or is a production-only secret declared in the secrets schema. An
     undocumented variable is one a developer cannot discover.

  2. Every variable .env.local.example documents is actually referenced by a
     compose file. A documented variable with no consumer configures nothing
     and quietly misleads.

  3. Every non-secret ${VAR} carries a default (${VAR:-x}), so that with no
     environment at all the compose files still resolve to the PRODUCTION
     stack. This is the property that makes local development additive: an
     unset variable can never silently change what production deploys.

  4. No SECRET carries a non-empty default. A password or token with a
     fallback value is a footgun — it lets a misconfigured deploy come up
     with a known credential instead of failing loudly.

Exit 0 when consistent, 1 otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# ${VAR}, ${VAR:-default}, ${VAR-default}
VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)((?::?-)[^}]*)?\}")
ASSIGN_RE = re.compile(r"^([A-Z_][A-Z0-9_]*)=")

COMPOSE_GLOBS = [
    "deploy/compose/prod/*.yml",
    "deploy/compose/overrides/*.yml",
]

ENV_EXAMPLE = ROOT / ".env.local.example"
SECRETS_SCHEMA = ROOT / "platform" / "vault" / "secrets-schema.yaml"

# Sensitive values, supplied by SOPS or vault at deploy time and never given a
# real fallback. ACME_EMAIL and ACME_CA_SERVER live in the secrets schema for
# historical reasons but are configuration, not credentials, so they are not
# listed here and do require defaults.
SENSITIVE = {
    "TRAEFIK_ADMIN_PASSWORD_HASH",
    "GRAFANA_ADMIN_PASSWORD",
    # Cloudflare API token for the ACME DNS-01 challenge.
    "CF_DNS_API_TOKEN",
    # Still a live credential — Hostinger is the VPS host — but consumed by
    # scripts/vps.sh and recreate-vps.yml rather than by compose.
    "HOSTINGER_API_KEY",
    # Platform database and identity-provider credentials. Supplied by SOPS or
    # vault at deploy time; a fallback value would let a misconfigured deploy
    # come up with a known database password or Keycloak admin login.
    "DB_USER",
    "DB_PASSWORD",
    "KC_ADMIN_USERNAME",
    "KC_ADMIN_PASSWORD",
    "VAULT_OIDC_CLIENT_SECRET",
    "GRAFANA_OIDC_CLIENT_SECRET",
}

# Consumed by scripts rather than by compose substitution.
SCRIPT_ONLY = {
    "CONTAINER_PREFIX",
    "NETWORK_PREFIX",
    "VOLUME_PREFIX",
    "VOLUME_PREFIX_BARE",
    "HTTP_PORT",
    "HTTPS_PORT",
    # Portainer stores its OAuth configuration in its own database, applied
    # through its API by scripts/portainer.sh — there is no compose ${VAR} to
    # reference, but the value still has to be documented and kept in SOPS.
    "PORTAINER_OIDC_CLIENT_SECRET",
    # Portainer's own admin account, used by scripts/portainer.sh to reach the
    # API and — more importantly — the way in when Keycloak is unavailable.
    # Not a compose variable: Portainer owns its user database.
    "PORTAINER_ADMIN_USERNAME",
    "PORTAINER_ADMIN_PASSWORD",
}


def documented(path: Path) -> set[str]:
    """Variable names assigned in an example file, including commented ones."""
    names: set[str] = set()
    if not path.exists():
        return names
    for line in path.read_text().splitlines():
        stripped = line.lstrip("# ").strip()
        match = ASSIGN_RE.match(stripped)
        if match:
            names.add(match.group(1))
    return names


def schema_keys(path: Path) -> set[str]:
    """Secret key names declared in the vault secrets schema."""
    if not path.exists():
        return set()
    return set(re.findall(r"^\s*-\s*key:\s*([A-Z_][A-Z0-9_]*)", path.read_text(), re.M))


def strip_comments(text: str) -> str:
    """Drop whole-line comments — headers use literal ${VAR} as documentation."""
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )


def referenced() -> tuple[dict[str, set[str]], list[str]]:
    """Variables used (mapped to the files using them), and defaultless uses."""
    uses: dict[str, set[str]] = {}
    problems: list[str] = []
    for pattern in COMPOSE_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            rel = str(path.relative_to(ROOT))
            body = strip_comments(path.read_text())
            for match in VAR_RE.finditer(body):
                name = match.group(1)
                raw = match.group(0)
                uses.setdefault(name, set()).add(rel)
                has_default = match.group(2) is not None
                default_value = ""
                if has_default:
                    default_value = raw[raw.index("-", raw.index(name)) + 1 : -1]
                if name in SENSITIVE:
                    if default_value:
                        problems.append(
                            f"{name} in {rel} has a non-empty default.\n"
                            f"    A credential must never fall back to a value; "
                            f"leave it unset so a misconfigured deploy fails loudly."
                        )
                elif not has_default:
                    problems.append(
                        f"{name} in {rel} has no default.\n"
                        f"    Write ${{{name}:-<production value>}} so that an unset "
                        f"environment still resolves to the production stack."
                    )
    return uses, problems


def main() -> int:
    env_documented = documented(ENV_EXAMPLE)
    secrets_documented = schema_keys(SECRETS_SCHEMA)
    all_documented = env_documented | secrets_documented | SENSITIVE

    uses, problems = referenced()

    for name in sorted(uses):
        if name not in all_documented:
            where = ", ".join(sorted(uses[name]))
            problems.append(
                f"{name} is used in {where} but documented nowhere.\n"
                f"    Add it to .env.local.example, or to "
                f"platform/vault/secrets-schema.yaml if it is a secret."
            )

    known = set(uses) | SCRIPT_ONLY | SENSITIVE
    for name in sorted(env_documented):
        if name not in known:
            problems.append(
                f"{name} is documented in .env.local.example but used nowhere.\n"
                f"    Remove it, or add the compose reference that consumes it."
            )

    if problems:
        print("Configuration surface drift:\n", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            f"\n{len(problems)} problem(s). Local and production share these "
            f"compose files; every variable must be documented, consumed, and "
            f"defaulted to the production value.",
            file=sys.stderr,
        )
        return 1

    print(
        f"Configuration surface consistent: {len(uses)} variable(s) used, "
        f"all documented and all defaulted to production values."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
