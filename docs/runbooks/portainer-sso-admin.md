# Portainer: SSO works, but the user sees nothing

**Symptom.** You sign in to `portainer.hill90.com` with Keycloak, it accepts you,
and then there are no environments — no local Docker endpoint, nothing to click.

**This is a licensing limitation, not a misconfiguration.** Nothing in Keycloak
will fix it. Do not spend an evening on realm roles, group mappers or client
scopes: Portainer Community Edition cannot read them.

`Portainer version verified live 2026-08-01: 2.39.5` — see [Which version this is for](#which-version-this-is-for).

---

## Why

Portainer keeps authentication in its own database and grants authorization from
its own user records. Two Portainer features would connect an SSO claim to
permissions, and **both are Business Edition**:

- claim/group → team mapping
- automatic administrator rights

Recorded at [`scripts/portainer.sh:12`](../../scripts/portainer.sh), and visible in
the applied settings as `"DefaultTeamID": 0` — no team, so no team-derived access.

So Community Edition does exactly what it supports: it **authenticates** the user
and auto-creates an account, then grants that account nothing. Login succeeds,
authorization is empty, and the UI is bare. Confirmed by measurement in
[sso-claim-measurement-2026-08-01.md](../decisions/sso-claim-measurement-2026-08-01.md):
`jon`'s token carries `realm_access.roles` populated, and Portainer CE cannot
consume it.

## The fix: promote once, per person

Sign in as the **local admin** — not through SSO — at
`https://portainer.hill90.com`, then:

> **Users** → *the user* → set **Role** to **Administrator** → **Update user**

The local login form is deliberately never hidden. `portainer.sh` leaves
`SSO=false` in Portainer's OAuth settings precisely so Keycloak can never become
the only way in, which is also what makes this promotion always possible. If you
need the local admin password, it is `PORTAINER_ADMIN_PASSWORD` in the SOPS store —
[secrets-workflow.md](secrets-workflow.md).

Equivalently through the API, if you would rather not click:

```
PUT /api/users/:id     {"Role": 1}      # 1 = administrator, 2 = standard
```

## What this costs, ongoing

**Every new SSO user needs this done again.** There is no group, no default team
and no claim that will do it for them — that is the whole point of the
limitation. Adding a person is therefore two steps, not one:

1. give them the realm role in Keycloak, as for every other service
2. sign in to Portainer as the local admin and promote them

Step 2 is invisible from Keycloak, so it is the one that gets forgotten. The
symptom when it is forgotten is exactly the one at the top of this page, which is
why it reads as a broken login rather than a missing step.

## The first SSO user is not a special case

Portainer makes the **first account on a fresh instance** an administrator. That
shortcut is not available here, and deliberately so: `portainer.sh init` creates
the local admin before OAuth is ever configured, so by the time anyone signs in
with Keycloak an administrator already exists. Every SSO user, including the
first, arrives as a standard user and needs promoting.

`portainer.sh apply` prints an abbreviated version of this at the end of a run —
but only someone running the script sees it, which is why it is written down here.

## Which version this is for

The compose file pins `portainer/portainer-ce:latest`
([`docker-compose.infra.yml:91`](../../deploy/compose/prod/docker-compose.infra.yml)),
so the running version moves on its own and the UI has changed between releases.
Check before trusting the click path:

```bash
docker run --rm --network container:portainer curlimages/curl:latest \
  -s http://localhost:9000/api/status
```

Returned `{"Version":"2.39.5", ...}` on 2026-08-01 — the same version the
promotion path was originally verified against.

**Precisely what is and is not verified**, because a pinned `latest` makes this
worth stating: the **version** was confirmed live today through that
unauthenticated endpoint. The **click path** is carried from the earlier
verification against this same 2.39.5 instance and was not re-walked in the UI
for this page — doing so needs an authenticated session, and this work was
read-only by constraint. If the version above no longer matches what
`/api/status` reports, treat the navigation as unverified and confirm it before
following it.

## Related

- [sso-fallback.md](sso-fallback.md) — getting in when Keycloak itself is down,
  and how the other integrations grant access
- [sso-claim-measurement-2026-08-01.md](../decisions/sso-claim-measurement-2026-08-01.md)
  — what each integration authorizes on, measured against real tokens
