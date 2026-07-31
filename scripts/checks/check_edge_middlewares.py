#!/usr/bin/env python3
"""Validate the edge middleware contract: references resolve, types match the pinned
Traefik major version, and an IP allowlist is never behind an authenticator.

WHY THIS EXISTS

Five production routers — traefik, portainer, grafana, vault, minio-console — are
reachable on the public internet by DNS and are protected by exactly one thing: the
`tailscale-only` middleware, an IP allowlist for the Tailscale CGNAT range. Nothing else
stands between them and the world. A comment saying "remember to rename this" is not a
control, so this asserts three properties that a comment cannot.

1. EVERY `@file` MIDDLEWARE A ROUTER REFERENCES ACTUALLY EXISTS.
   Traefik resolves middleware references at request time, not at load time. A router
   pointing at a middleware that does not exist does not fail to load — the request
   errors, and in the meantime the router is present and the protection is not.

2. MIDDLEWARE TYPES MATCH THE PINNED TRAEFIK MAJOR VERSION.
   This is the hazard worth the most: `ipWhiteList` (v2) was renamed `ipAllowList` in
   v3. Bumping the image to v3 without renaming leaves a definition Traefik v3 does not
   recognise, on precisely the routers whose entire protection is that definition. The
   failure is silent in the way that matters — the routers still load and still serve.
   This check fails the build instead.

3. AN IP ALLOWLIST IS NEVER ORDERED BEHIND AN AUTHENTICATOR.
   Middleware chains run left to right. `auth@file,tailscale-only@file` authenticates
   first, so an off-tailnet request receives a `WWW-Authenticate` prompt and a guessing
   oracle before the allowlist ever refuses it. Same protection for a legitimate user,
   strictly more information disclosed to everyone else. Observed in production on
   2026-07-31: traefik.hill90.com answered 401 from off-tailnet while every other
   admin router answered 403.

Exit codes:
    0 — all three properties hold
    1 — at least one violation
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_DIR = ROOT / "deploy" / "compose" / "prod"
MIDDLEWARES = ROOT / "platform" / "edge" / "dynamic" / "middlewares.yml"

# Middleware type keys that exist in only one Traefik major version. The point of the
# check is the first entry; the rest are included because the same class of rename has
# bitten other keys and a one-entry table invites "it is only about ipWhiteList".
VERSIONED_TYPES = {
    "ipWhiteList": {"v2"},
    "ipAllowList": {"v3"},
}

# Middleware types that gate on network location. These must never be preceded by an
# authenticating middleware in a chain.
LOCATION_GATES = {"ipWhiteList", "ipAllowList"}
AUTHENTICATORS = {"basicAuth", "digestAuth", "forwardAuth"}


def traefik_major() -> tuple[str, str]:
    """Return (major, raw_tag) for the pinned Traefik image."""
    for path in sorted(COMPOSE_DIR.glob("*.yml")):
        for line in path.read_text().splitlines():
            m = re.search(r"image:\s*traefik:v(\d+)([\w.\-]*)", line)
            if m:
                return f"v{m.group(1)}", f"v{m.group(1)}{m.group(2)}"
    return "", ""


def defined_middlewares() -> dict[str, str]:
    """Map middleware name -> its type key, parsed from the file provider config.

    Deliberately a line parser rather than yaml.safe_load: this file is mounted into
    Traefik verbatim and carries long comment blocks that are part of its value. A
    round-trip through a YAML library would be a reason to rewrite it, and rewriting a
    file whose comments record why the allowlist contains exactly one CIDR is the last
    thing this check should encourage.
    """
    out: dict[str, str] = {}
    name = None
    for line in MIDDLEWARES.read_text().splitlines():
        if re.match(r"^\s{4}[A-Za-z][\w-]*:\s*$", line):
            name = line.strip().rstrip(":")
        elif name and re.match(r"^\s{6}[A-Za-z][\w]*:", line):
            # Not `:\s*$` — an inline body such as `compress: {}` is a complete
            # definition and was missed by an anchored version of this pattern, which
            # would have reported a defined middleware as unresolvable. Found by
            # counting the parsed names against the file rather than by a failure.
            out[name] = line.strip().split(":")[0]
            name = None
    return out


def referenced_chains() -> list[tuple[str, str, list[str]]]:
    """Return (compose file, router, [middleware names]) for every router chain."""
    chains = []
    pat = re.compile(r"traefik\.http\.routers\.([\w-]+)\.middlewares=([^\"']+)")
    for path in sorted(COMPOSE_DIR.glob("*.yml")):
        for line in path.read_text().splitlines():
            m = pat.search(line)
            if not m:
                continue
            raw = m.group(2)
            # Strip a ${VAR:-default} wrapper and read the default, which is what
            # production actually uses — the variable is an escape hatch, not the norm.
            d = re.search(r"\$\{[A-Z_]+:-([^}]*)\}", raw)
            if d:
                raw = d.group(1)
            names = [p.strip().split("@")[0] for p in raw.split(",") if p.strip()]
            chains.append((path.name, m.group(1), names))
    return chains


def main() -> int:
    if not MIDDLEWARES.exists():
        print(f"FAIL: {MIDDLEWARES} not found", file=sys.stderr)
        return 1

    major, tag = traefik_major()
    defined = defined_middlewares()
    chains = referenced_chains()
    failures: list[str] = []

    print(f"Traefik pinned at {tag or '<unknown>'} (major {major or '?'})")
    print(f"Middlewares defined: {len(defined)} — {', '.join(sorted(defined))}")
    print(f"Router chains found: {len(chains)}")

    if not major:
        failures.append("Could not determine the pinned Traefik major version from "
                        f"{COMPOSE_DIR}/*.yml — the version check cannot run.")
    if not defined:
        failures.append(f"No middleware definitions parsed from {MIDDLEWARES} — the "
                        "reference check would pass vacuously.")
    if not chains:
        failures.append("No router middleware chains found — the ordering check would "
                        "pass vacuously.")

    # 1. references resolve
    for fname, router, names in chains:
        for n in names:
            if n not in defined:
                failures.append(
                    f"{fname}: router '{router}' references middleware '{n}', which is "
                    f"not defined in {MIDDLEWARES.name}. Traefik resolves references at "
                    "request time, so the router will load and serve without it.")

    # 2. types valid for the pinned major version
    for name, typ in sorted(defined.items()):
        allowed = VERSIONED_TYPES.get(typ)
        if allowed and major and major not in allowed:
            failures.append(
                f"{MIDDLEWARES.name}: middleware '{name}' uses '{typ}', which exists "
                f"only in Traefik {'/'.join(sorted(allowed))}, but the image is pinned "
                f"at {tag}. Rename it — this is the silent-loss case: the routers that "
                "depend on it keep serving with no allowlist.")

    # 3. a location gate is never behind an authenticator
    for fname, router, names in chains:
        types = [(n, defined.get(n, "")) for n in names]
        seen_auth: list[str] = []
        for n, typ in types:
            if typ in AUTHENTICATORS:
                seen_auth.append(n)
            elif typ in LOCATION_GATES and seen_auth:
                failures.append(
                    f"{fname}: router '{router}' orders '{n}' ({typ}) after "
                    f"{', '.join(seen_auth)}. Chains run left to right, so an "
                    "off-network request is challenged for credentials before being "
                    f"refused. Put '{n}' first.")

    print()
    if failures:
        print(f"FAIL — {len(failures)} problem(s):", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("PASS — references resolve, types match the pinned version, and no IP "
          "allowlist sits behind an authenticator.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
