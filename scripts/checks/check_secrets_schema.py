#!/usr/bin/env python3
"""Validate vault/SOPS/compose secret key consistency.

Loads platform/vault/secrets-schema.yaml and cross-references it against:
  - Compose files in deploy/compose/prod/ for ${VAR} references
  - infra/secrets/prod.enc.env.example for SOPS key names

Exit codes:
    0 — no violations (or advisory mode with warnings)
    1 — violations found in strict mode (SECRETS_SCHEMA_STRICT=1)
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "platform" / "vault" / "secrets-schema.yaml"
COMPOSE_DIR = ROOT / "deploy" / "compose" / "prod"
SOPS_EXAMPLE = ROOT / "infra" / "secrets" / "prod.enc.env.example"

VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}")


def load_schema(path: Path) -> dict:
    """Load and return the secrets schema YAML."""
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def extract_compose_vars(compose_dir: Path) -> dict[str, set[str]]:
    """Extract ${VAR} references from all compose files.

    Returns a dict mapping VAR_NAME -> set of compose file basenames.
    """
    refs: dict[str, set[str]] = {}
    for f in sorted(compose_dir.glob("docker-compose.*.yml")):
        content = f.read_text(encoding="utf-8")
        for match in VAR_RE.finditer(content):
            var = match.group(1)
            refs.setdefault(var, set()).add(f.name)
    return refs


def extract_sops_keys(example_path: Path) -> set[str]:
    """Extract key names from the SOPS example file."""
    keys: set[str] = set()
    if not example_path.exists():
        return keys
    for line in example_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key = line.split("=", 1)[0].strip()
            if key:
                keys.add(key)
    return keys


def validate(schema: dict, compose_refs: dict[str, set[str]], sops_keys: set[str]) -> list[str]:
    """Run all validations and return a list of warning messages."""
    warnings: list[str] = []

    excluded = set(schema.get("excluded_vars", []))

    # Build the set of all schema-declared keys
    runtime = schema.get("runtime_secrets", [])
    schema_keys: dict[str, dict] = {}
    for entry in runtime:
        schema_keys[entry["key"]] = entry

    bootstrap = set(schema.get("bootstrap_secrets", []))
    vault_mgmt = set(schema.get("vault_management_secrets", []))
    approle_svcs = schema.get("vault_approle_services", [])

    # Expand AppRole service patterns into expected SOPS keys
    approle_keys: set[str] = set()
    for svc in approle_svcs:
        approle_keys.add(f"VAULT_{svc.upper()}_ROLE_ID")
        approle_keys.add(f"VAULT_{svc.upper()}_SECRET_ID")

    all_schema_keys = (
        set(schema_keys.keys())
        | bootstrap
        | vault_mgmt
        | approle_keys
        | excluded
    )

    # 1. Compose ${VAR} not in schema
    for var, files in sorted(compose_refs.items()):
        if var in excluded:
            continue
        if var not in schema_keys:
            file_list = ", ".join(sorted(files))
            warnings.append(
                f"Compose ref ${{{var}}} (in {file_list}) not found in schema"
            )

    # 2. SOPS key not in schema
    for key in sorted(sops_keys):
        if key in excluded:
            continue
        if key not in all_schema_keys:
            warnings.append(f"SOPS key '{key}' not found in any schema category")

    # 3. Schema key not in SOPS example
    for key in sorted(set(schema_keys.keys()) | bootstrap | vault_mgmt | approle_keys):
        if key in excluded:
            continue
        if key not in sops_keys:
            warnings.append(f"Schema key '{key}' missing from SOPS example")

    # 4. Duplicate vault key without dedup annotation
    # Group keys by vault_path to detect duplicates
    path_keys: dict[str, list[str]] = {}
    for entry in runtime:
        path_keys.setdefault(entry["vault_path"], []).append(entry["key"])

    dedup_paths: dict[str, set[str]] = {}
    for entry in runtime:
        if "dedup" in entry:
            dedup_paths.setdefault(entry["key"], set()).update(entry["dedup"])

    # Check for keys that appear in multiple vault paths without dedup
    key_paths: dict[str, list[str]] = {}
    for entry in runtime:
        key_paths.setdefault(entry["key"], []).append(entry["vault_path"])

    for key, paths in key_paths.items():
        if len(paths) > 1 and key not in dedup_paths:
            warnings.append(
                f"Key '{key}' appears in multiple vault paths {paths} without dedup annotation"
            )

    # 5. Schema compose_refs don't match actual compose refs
    for entry in runtime:
        key = entry["key"]
        declared_refs = set(entry.get("compose_refs", []))
        actual_refs = compose_refs.get(key, set())
        if declared_refs != actual_refs:
            if declared_refs - actual_refs:
                extra = ", ".join(sorted(declared_refs - actual_refs))
                warnings.append(
                    f"Schema declares compose_refs for '{key}' in [{extra}] "
                    f"but no ${{{{key}}}} found there"
                )
            if actual_refs - declared_refs:
                missing = ", ".join(sorted(actual_refs - declared_refs))
                warnings.append(
                    f"Compose ref ${{{key}}} found in [{missing}] "
                    f"but not declared in schema compose_refs"
                )

    return warnings


def main() -> int:
    strict = os.environ.get("SECRETS_SCHEMA_STRICT", "0") == "1"

    # Allow overrides for testing
    schema_path = Path(os.environ.get("_SCHEMA_PATH_OVERRIDE", str(SCHEMA_PATH)))
    compose_dir = Path(os.environ.get("_COMPOSE_DIR_OVERRIDE", str(COMPOSE_DIR)))
    sops_example = Path(os.environ.get("_SOPS_EXAMPLE_OVERRIDE", str(SOPS_EXAMPLE)))

    if not schema_path.exists():
        print(f"ERROR: Schema file not found: {schema_path}")
        return 1

    schema = load_schema(schema_path)
    compose_refs = extract_compose_vars(compose_dir)
    sops_keys = extract_sops_keys(sops_example)

    warnings = validate(schema, compose_refs, sops_keys)

    if warnings:
        print(f"Secrets schema validation: {len(warnings)} warning(s)")
        for w in warnings:
            print(f"  [WARN] {w}")
    else:
        print("Secrets schema validation: all checks passed")

    # Write to GITHUB_STEP_SUMMARY if available
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write("## Secrets Schema Validation\n\n")
            if warnings:
                f.write(f"**{len(warnings)} warning(s) found:**\n\n")
                for w in warnings:
                    f.write(f"- {w}\n")
            else:
                f.write("All checks passed.\n")
            f.write("\n")

    if warnings and strict:
        print("\nStrict mode: failing due to warnings above")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
