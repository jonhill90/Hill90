# Three credential exposures in one day, and the shape they share

**Recorded 2026-07-30.** Brief by intent. The point of writing it down is the shared
shape and the fix, not the incidents.

## What happened

| # | Credential | Exposed where | By | Status |
|---|---|---|---|---|
| 1 | **Production Keycloak `master`-realm admin password** (`KC_ADMIN_PASSWORD`) | agent transcript, in a remote `bash` error line | agent (Hill90 lane) | **still valid**, rotation prepared and awaiting Jon — [../runbooks/keycloak-admin-rotation.md](../runbooks/keycloak-admin-rotation.md) |
| 2 | **Tenant Postgres role credential** (`hill90_app`) | truncated `docker inspect` output | operator | rotated within the hour |
| 3 | **A local probe user's password**, hardcoded in a committed script | `scripts/checks/tenant-login-local-test.sh` | agent (Hill90 lane) | fixed in this change — generated at runtime |

Exposure 1 is the serious one, and not because of the value's length. The account
administers every realm: it can mint users, grant the realm `admin` role that confers
Grafana Admin and OpenBao access, and read or rewrite any client secret. It also sits
behind a **publicly reachable** admin console —
`https://auth.hill90.com/admin/master/console/` returns `200`, and that Traefik router
carries no middleware, unlike Traefik, Portainer, Grafana and Vault which are
Tailscale-only. Severity comes from the combination, not the leak alone.

Exposure 3 is small — the password only ever authenticated two users the script
itself creates and deletes, in a local realm — but invariant 7 says secrets do not
live in the tree, and a literal password in a committed file is a literal password in
a committed file.

## The shape

**A value that had to be handled ended up in output that gets retained.**

None of the three was a case of storing a secret in the wrong place, or of a weak
secret, or of a missing control. In every case the value was correctly stored, and
then something *printed* it — a `docker inspect`, a shell error message, a test
fixture. The retention is the mechanism: transcripts, logs and git history all keep
what was printed.

The mechanism of exposure 1 is worth being concrete about, because it was not a
`print` statement:

```
printf '%s\n%s\n' "$USER" "$PASSWORD" | ssh deploy@vps 'bash -s' <<'REMOTE' … REMOTE
```

The heredoc claimed `ssh`'s stdin, so the piped credentials never reached the script —
they were handed to the remote shell **as commands**. Remote `bash` tried to execute
the password as a filename and echoed it back inside its own error text. Nothing
printed the secret on purpose; a plumbing mistake turned it into a command name, and
the error handler did the rest.

## The fix that works, and it is not "be careful"

The operator's fix for exposure 2 is the instructive one: it did not try to stop
people running `docker inspect`. **It made the safe way to answer the question the
easy one.** That generalises, so apply the same test here.

**What was I actually trying to find out?** Whether a human had completed a sign-in.
I wanted live session counts from the Keycloak admin API, which needs an admin token,
so I hand-rolled one.

**Was there already a redacted path? Yes, and I bypassed it.** `scripts/keycloak.sh`
`kc_login` passes the admin password via `KC_CLI_PASSWORD` and `docker exec -e`
*specifically* so it never appears in argv, with a comment saying why, and it prints
nothing. Every step of the rotation runbook uses that pattern. The safe path existed
in the very file I had been editing; my ad-hoc command went around it.

So the honest finding is not "the tooling was missing" but "the tooling did not cover
the question I had". Two follow-ups fall out, neither done here:

1. **Add a read-only `keycloak.sh sessions`** (proposed, not built) that reports
   session counts per client and per user. It would answer "has anyone signed in?"
   without anybody minting an admin token by hand. This is the direct analogue of the
   `docker inspect` fix: the question was legitimate, so give it a safe answer.
2. **Turn on Keycloak login events.** `events_enabled=false` on both realms
   (`Verified 2026-07-30 02:07 UTC`), which is *why* the question needed the admin
   API at all — sessions live in Infinispan and `event_entity` is empty. With events
   stored, the most-asked question in this estate becomes a database query and needs
   no privileged credential. Already noted in `CLAUDE.md`.

## One thing that did work

Every one of the three was caught and reported immediately by the person who caused
it, and exposure 2 was rotated inside the hour. That is the control that actually
held today, and it held three times out of three.

## See also

- [../runbooks/keycloak-admin-rotation.md](../runbooks/keycloak-admin-rotation.md) —
  the prepared rotation, including a rehearsed break-glass
- [tenant-credential-ownership.md](tenant-credential-ownership.md) — who owns which
  credential, decided the same day
