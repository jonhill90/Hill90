#!/usr/bin/env python3
"""Pin the tenant clients in platform-realm.json to the shape production runs.

WHY THIS EXISTS
===============

A tenant of this platform authenticates against realm `platform`, and its
authorisation depends on ONE claim: `resource_access.hill90-ui.roles`. That claim
is emitted by Keycloak's built-in `roles` client scope. Nothing logs a warning if
it stops being emitted — the token still validates, the login still succeeds, and
every permission check silently returns empty. A user sees an app with no
permissions and no error.

So four things are asserted here, and each one has a specific way of going wrong:

1. `hill90-ui` keeps `roles` in its `defaultClientScopes`. Left implicit, the
   claim depends on the realm's default-client-scope list, which is edited
   elsewhere and for other reasons.

1b. `hill90-ui` also keeps `basic` — added for #704 (2026-08-04). Keycloak 24+
   emits the `sub` claim into the access token via the `basic` client scope,
   and hill90-app reads `user.sub` at 158 call sites to answer "is this
   yours?". A client CREATED through `kcadm` (scripts/keycloak.sh
   tenant-clients, before this fix) or through the realm's own default scopes
   gets `basic` automatically; this FILE did not list it explicitly, so a
   REALM IMPORT — the path a VPS rebuild takes — would produce a `hill90-ui`
   that issues tokens with no `sub`. hill90-app#306, already deployed, makes
   the api refuse such a token outright, so the failure is a total outage on
   every request from every user, not a quiet bug. The live realm has always
   had `basic` (it was built by kcadm, which inherited it); this file did not,
   and until now nothing compared the two.

2. `hill90-ui` has NO realm-roles mapper. This is the inversion worth
   understanding, because the obvious instinct is backwards:

   `scripts/keycloak.sh` gives every PLATFORM client a realm-roles mapper, and
   `hill90-vault` deliberately uses claim `realm_roles` because
   `vault.sh setup-oidc` binds `{"realm_roles": ["platform-admin"]}`. That is correct FOR
   THE PLATFORM'S OWN CLIENTS.

   For the tenant it would be a privilege hole. The `platform` realm grants
   Grafana Admin and OpenBao access off a REALM role — `platform-admin` since
   #637 and Stage 2b, `admin` before that. The app reads
   client roles precisely so that an app admin does not inherit infrastructure
   admin — `services/api/src/middleware/keycloak-config.ts` says there is
   deliberately no fallback to `realm_roles` for that reason. Adding a
   realm-roles mapper here would re-open what the client-role design closed.

3. The audience mapper for `hill90-api` survives. Without it the api rejects the
   UI's tokens on audience validation.

Plus the do-not-clobber assertions: `hill90-vault` must still be present with its
`realm_roles` mapper intact, because adding to this file must not disturb it.

Every expected value was read from the LIVE platform realm on 2026-07-30, not
invented.

Usage: python3 scripts/checks/check_realm_tenant_clients.py [path-to-realm.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REALM = ROOT / "platform" / "auth" / "keycloak" / "platform-realm.json"

# The claim the tenant's services actually read. Changing this string means the
# app changed; go and check it before editing.
TENANT_ROLES_CLAIM = "resource_access.hill90-ui.roles"

# Mapper types that would put REALM roles into a tenant token.
REALM_ROLE_MAPPERS = {
    "oidc-usermodel-realm-role-mapper",
    "oidc-usermodel-role-mapper",
}


def fail(problems: list[str], msg: str) -> None:
    problems.append(msg)


def check(realm: dict) -> list[str]:
    problems: list[str] = []
    clients = {c.get("clientId"): c for c in realm.get("clients", [])}

    # ---- the tenant's clients exist -------------------------------------
    for cid in ("hill90-ui", "hill90-api"):
        if cid not in clients:
            fail(problems, f"client '{cid}' is missing — a tenant cannot authenticate without it")
    if problems:
        return problems

    ui = clients["hill90-ui"]
    api = clients["hill90-api"]

    # ---- 1. the roles scope is pinned -----------------------------------
    scopes = ui.get("defaultClientScopes")
    if scopes is None:
        fail(
            problems,
            "hill90-ui has no explicit defaultClientScopes. "
            f"{TENANT_ROLES_CLAIM} then depends on the realm's default list; pin it.",
        )
    else:
        if "roles" not in scopes:
            fail(
                problems,
                "hill90-ui's defaultClientScopes does not include 'roles', so "
                f"{TENANT_ROLES_CLAIM} is never emitted and every permission check "
                "silently returns empty.",
            )
        # ---- 1b. the basic scope is pinned too ---------------------------
        # basic is what emits `sub`. hill90-app reads user.sub at 158 call
        # sites, and hill90-app#306 makes the api refuse a token that has
        # none — so a REALM IMPORT (a VPS rebuild) that used this file
        # without 'basic' would authenticate nobody. See #704.
        if "basic" not in scopes:
            fail(
                problems,
                "hill90-ui's defaultClientScopes does not include 'basic', so "
                "issued tokens carry no 'sub' claim. hill90-app#306 makes the api "
                "refuse such a token outright — a realm import from this file "
                "would authenticate nobody. See #704.",
            )

    # ---- 2. no realm-roles mapper on the tenant client ------------------
    for m in ui.get("protocolMappers", []) or []:
        if m.get("protocolMapper") in REALM_ROLE_MAPPERS:
            claim = (m.get("config") or {}).get("claim.name", "<unset>")
            fail(
                problems,
                f"hill90-ui has a realm-roles mapper ('{m.get('name')}' -> claim "
                f"'{claim}'). That is correct for hill90-vault and WRONG here: the "
                "platform realm grants Grafana Admin and OpenBao off realm role "
                "'admin', and the app reads client roles specifically so an app "
                "admin does not inherit infrastructure admin.",
            )

    # ---- 3. the audience mapper survives --------------------------------
    aud = [
        m for m in (ui.get("protocolMappers") or [])
        if m.get("protocolMapper") == "oidc-audience-mapper"
        and (m.get("config") or {}).get("included.client.audience") == "hill90-api"
    ]
    if not aud:
        fail(
            problems,
            "hill90-ui has no audience mapper including 'hill90-api'. The api "
            "validates audience, so its tokens would be rejected.",
        )
    else:
        cfg = aud[0].get("config") or {}
        if cfg.get("access.token.claim") != "true":
            fail(problems, "the hill90-api audience mapper does not set access.token.claim=true")

    # ---- the client roles the app assigns -------------------------------
    ui_roles = {r.get("name") for r in (realm.get("roles", {}).get("client", {}) or {}).get("hill90-ui", [])}
    for r in ("user", "admin"):
        if r not in ui_roles:
            fail(problems, f"client role 'hill90-ui:{r}' is not defined in roles.client")

    # ---- shape of the two clients, as production runs them --------------
    if ui.get("publicClient") is not False:
        fail(problems, "hill90-ui must be a confidential client (publicClient: false), as in production")
    if ui.get("standardFlowEnabled") is not True:
        fail(problems, "hill90-ui must have standardFlowEnabled: true")
    if ui.get("directAccessGrantsEnabled") is not False:
        fail(
            problems,
            "hill90-ui must have directAccessGrantsEnabled: false — production does, "
            "and enabling it turns a stolen password into a token with no browser involved",
        )
    if api.get("bearerOnly") is not True:
        fail(problems, "hill90-api must be bearerOnly: true, as in production")
    if api.get("standardFlowEnabled") is not False:
        fail(problems, "hill90-api must have standardFlowEnabled: false — it is not a login client")

    # ---- do not clobber -------------------------------------------------
    vault = clients.get("hill90-vault")
    if vault is None:
        fail(problems, "hill90-vault has disappeared from the realm file — OpenBao SSO depends on it")
    else:
        vault_realm_mappers = [
            m for m in (vault.get("protocolMappers") or [])
            if m.get("protocolMapper") in REALM_ROLE_MAPPERS
            and (m.get("config") or {}).get("claim.name") == "realm_roles"
        ]
        if not vault_realm_mappers:
            fail(
                problems,
                "hill90-vault has lost its realm-roles mapper on claim 'realm_roles'. "
                "vault.sh setup-oidc binds that exact claim; OpenBao SSO breaks without it.",
            )

    return problems


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REALM
    if not path.is_file():
        print(f"realm file not found: {path}", file=sys.stderr)
        return 2
    realm = json.loads(path.read_text())
    problems = check(realm)
    if problems:
        print(f"Tenant client check FAILED for {path.name}:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(
        "Tenant clients pinned: hill90-ui (confidential, roles scope, audience "
        "mapper, no realm-roles mapper), hill90-api (bearer-only), client roles "
        "user+admin, hill90-vault intact."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
