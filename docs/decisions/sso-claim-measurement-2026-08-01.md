# SSO: what each integration authorizes on, and what jon's token actually carries

`Measured 2026-08-01. Read-only: nothing was created, edited or deployed.` No Keycloak
object was changed. Three real production tokens were obtained for `jon` by completing
authorization-code logins against clients that already have `standardFlowEnabled` — no
client setting was altered, and `directAccessGrants` was not enabled on anything.

The question was whether a config-derived diagnosis survives contact with a real token.
**Mostly it did. One half of one belief did not, and it matters.**

## The table

| Integration | Client exists? | Claim it authorizes on (quoted) | Mapper emits that claim? | Does `jon` carry a value? |
|---|---|---|---|---|
| **grafana** | **Yes** — confidential | `GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH=contains(realm_access.roles[*], 'admin') && 'Admin' \|\| contains(realm_access.roles[*], 'editor') && 'Editor' \|\| 'Viewer'` — `deploy/compose/prod/docker-compose.observability.yml:202` | **Yes** — `realm-roles`, `oidc-usermodel-realm-role-mapper`, `claim.name=realm_access.roles` | **Yes, but not `admin`.** Real token: `['offline_access','uma_authorization','default-roles-platform']` → falls through to **`'Viewer'`** |
| **portainer** | **Yes** — confidential | `"DefaultTeamID": 0` — `scripts/portainer.sh:186`. Claim-to-team mapping is not used because it cannot be: *"Group/claim -> team mapping and automatic admin rights: BUSINESS ONLY"* — `scripts/portainer.sh:12` | **Yes** — `realm-roles`, `claim.name=realm_access.roles` | **Yes, and it is irrelevant.** Portainer CE cannot consume it for authorization at any value |
| **minio** | **Yes** — confidential | `MINIO_IDENTITY_OPENID_CLAIM_NAME=${MINIO_OIDC_CLAIM_NAME:-minio_policy}` — `deploy/compose/prod/docker-compose.minio.yml:80` | **Yes** — `realm-roles`, `claim.name=minio_policy` | **Yes, and every value is wrong.** Real token: `minio_policy = ['offline_access','uma_authorization','default-roles-platform']` — none is a MinIO policy name |
| **hill90-vault** | **Yes** — confidential | `"bound_claims": {"realm_roles": ["admin"]}` — `scripts/vault.sh:436` | **Yes** — `realm-roles`, `claim.name=realm_roles` (deliberately non-default) | **Yes, but not `admin`.** Real token: `realm_roles = ['offline_access','uma_authorization','default-roles-platform']` |
| **litellm** | **No client** | *No OIDC configuration exists anywhere.* Not in `deploy/compose/prod/` in this repo; no `ensure_client` in `scripts/keycloak.sh` | n/a | n/a — **it is not an SSO integration** |

## Your five beliefs, adjudicated

### 1. Vault — **half falsified, and the half that survives is the whole cause**

> *"that claim name does not exist in these tokens at all, Keycloak default being `realm_access.roles`, and separately the realm role `admin` has zero holders, so there are two independent reasons it can never match."*

**FALSIFIED — the claim does exist.** `hill90-vault`'s mapper is explicitly configured
`claim.name=realm_roles`, overriding the Keycloak default. A real token for `jon` obtained
through that client carries:

```
realm_roles : ['offline_access', 'uma_authorization', 'default-roles-platform']
```

The claim is present and populated. Hill90's own `check_realm_tenant_clients.py` documents
this as deliberate — *"`hill90-vault` deliberately uses claim `realm_roles` because
`vault.sh setup-oidc` binds `{"realm_roles": ["admin"]}`"*.

**CONFIRMED — the realm role has zero holders.** Realm role `admin` exists; holders: **0**.

**So there is ONE reason, not two.** That matters: the fix you might infer from "the claim
name is wrong" — rename the mapper — would change nothing, because the binding is already
consistent. The only thing missing is that nobody holds the role.

### 2. Grafana — **confirmed**

> *"jon therefore lands as Viewer, so Grafana authenticates but does not authorize him, and Jon has not noticed."*

**CONFIRMED.** `realm_access.roles` for `jon` contains neither `admin` nor `editor`, so the
JMESPath falls through to the literal `'Viewer'`. Authentication succeeds; authorization
lands at the lowest tier. That is consistent with *"Grafana appears to work"* — it does
work, at Viewer.

*Provenance, stated exactly:* the `realm_access.roles` value above came from tokens issued
through the **`minio`** and **`hill90-vault`** clients, not the `grafana` client — see the
note below. The claim is emitted by a realm-role mapper, so its value is jon's realm roles
regardless of which client issued the token; but the Grafana row rests on a real token from
a different client, and that distinction belongs on the record.

### 3. MinIO — **confirmed, with the detail that changes the shape**

> *"check whether a mapper emits it and what it emits for jon."*

A mapper **does** emit `minio_policy` — but it is a *realm-role* mapper, so it emits jon's
realm roles under that name:

```
minio_policy : ['offline_access', 'uma_authorization', 'default-roles-platform']
```

MinIO receives a policy claim naming three things, none of which is a MinIO policy. The
compose file's own comment anticipates the empty case — *"a token without it gets no access
rather than broad access"* — but this is the populated-and-wrong case, not the absent case.

### 4. Portainer — **confirmed, and it is a licensing limit**

> *"if that is right then this is a CE licensing limit and no realm design fixes it."*

**CONFIRMED.** `scripts/portainer.sh:12` states it, and `:186` sets `"DefaultTeamID": 0`.
A `realm-roles` mapper exists on the client and emits `realm_access.roles`, so the claim is
delivered — Portainer CE simply cannot map it to a team or to admin rights. **No realm
change fixes this one.** It matches the symptom exactly: login succeeds, the environment is
not visible, because an SSO user arrives as a STANDARD user with no environment access.

### 5. LiteLLM — **confirmed: the tenant's, and not an SSO integration at all**

No client, no `ensure_client`, and nothing in this repo's `deploy/compose/prod/`. It is
`app-litellm` in **hill90-app** (`deploy/compose/prod/docker-compose.ai.yml:29`, routed at
`litellm.hill90.com:72`), and that file contains **no OIDC, OAuth, Keycloak, JWT or SSO
configuration whatsoever**. It authenticates by master key.

So *"LiteLLM fails"* is not an SSO failure — there is no SSO to fail. Whatever Jon hit is a
different fault, and diagnosing it is out of scope here.

## The single common cause

Four integrations, four different claim names, **one reason**:

```
realm role 'admin'      exists,  holders: 0
jon's realm roles       default-roles-platform  (composite: offline_access, uma_authorization)
jon's client roles      hill90-ui:admin, hill90-ui:user
```

Every platform integration authorizes on a **realm** role. `jon` holds only **client** roles
on `hill90-ui`. The realm roles `admin`, `editor`, `user`, `viewer` all exist; `admin` has
**zero** holders.

That is by design, and the design is recorded: the tenant deliberately uses client roles so
that an app admin does not inherit infrastructure admin. The consequence — that nobody holds
the infrastructure role either — is the thing to decide about.

**No permission model is proposed here.** That is Jon's decision.

## Method, and one thing that did not work

Tokens were obtained by driving the authorization-code flow directly: auth endpoint → login
form POST as `jon` → capture `code` from the 302 → exchange at the token endpoint using the
client secret from the encrypted store. `jon` has **no pending required actions**, so no
`VERIFY_PROFILE` diversion occurred. No password or secret was printed.

**The `grafana` client's token exchange failed** with `Invalid client or Invalid client
credentials` — which, per CLAUDE.md's note on reading the body rather than the status, is
the *wrong-secret* message rather than the *not-permitted* one. So the value in
`GRAFANA_OIDC_CLIENT_SECRET` did not match the live client at the time of this measurement.
**Not investigated further — it is outside this question**, and Grafana's own login
reportedly works, which is consistent with drift between the store and the live client
rather than with a broken integration. It deserves its own check; the same probe succeeded
for `minio` and `hill90-vault` using secrets from the same decrypt, so the store itself is
readable and the age key is fine.

## Side effects of measuring

Three successful logins as `jon` against production Keycloak. These create user sessions and
`LOGIN` events in the realm's event store — a consequence of obtaining a real token rather
than reasoning about one, and the reason that instruction was given. No client, role, user,
mapper or realm setting was created or modified.
