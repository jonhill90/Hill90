# Contributing to Hill90

Hill90 is homelab infrastructure for a single Hostinger VPS: Ansible
provisioning, Traefik edge routing, an observability stack, SOPS/OpenBao
secrets, and Tailscale-secured SSH.

> **Scope:** Hill90 is not an application host. The AI agent application that
> once lived here was removed in July 2026 — not shelved: it runs in production
> as a **tenant** of this platform, from
> [`hill90-app`](https://github.com/jonhill90/hill90-app). See
> [Infra/app separation](docs/decisions/infra-app-separation.md); the code is
> preserved at the `archive/app-stack-final` tag.

## Issue Tracking

Issues live in **GitHub Issues, in the repository whose code they touch**.

| Work | Repository |
|---|---|
| VPS, Traefik, observability, secrets, Ansible, deploy | [Hill90](https://github.com/jonhill90/Hill90) — public |
| The AI agent platform | [hill90-app](https://github.com/jonhill90/hill90-app) — **private** |
| The published docs site, docs.hill90.com | [hill90-docs](https://github.com/jonhill90/hill90-docs) — **private** |
| The extracted, reusable compose template | [docker-infra-template](https://github.com/jonhill90/docker-infra-template) — public |

Two of those repositories are private and will 404 for anyone but their owner.
If you cannot reach the repository a thing belongs to, file it here instead.

Work spanning more than one repository is filed here in Hill90 and links out to
the repositories it touches. Do not mirror one issue into several repositories.
Hill90 is public, so keep anything that should not be public — private-repo
internals, hostnames, anything resembling a credential — in the private
repository's own issue and link to it rather than restating it here.

### `AI-###` and `JON-###` in the history

Until 2026-07-26 this project tracked work in a Linear workspace with two teams:
`AI` for the application and `JON` for the infrastructure. Identifiers like
`AI-124` or `JON-47` appear throughout commit messages, code comments, decision
records and runbooks in all four repositories. **They are Linear identifiers,
not GitHub issue numbers** — `JON-47` is unrelated to `#47` in this repository,
which is a pull request about logo animation.

That workspace was retired as a tracker but deliberately not deleted; it is the
record of how the project got here. It held about 250 issues across the two
teams, and all but two were already closed at the cutover, so only those two
were carried across: `JON-55` became [#532](https://github.com/jonhill90/Hill90/issues/532)
here, and `AI-258` became [hill90-app#8](https://github.com/jonhill90/hill90-app/issues/8).
The rest were deliberately left in Linear rather than imported, so following one
of those identifiers means looking it up there.

## Pull Request Workflow

1. **Plan** — for anything touching three or more files, agree on the approach
   before writing code.
2. **Implement** — tests first for code changes; direct surgical edits for
   infra and docs.
3. **Verify locally** — run the relevant checks (`bats`, `shellcheck`, compose
   validation).
4. **Branch** — `git checkout -b <type>/<description>`.
5. **Commit** — see the format below.
6. **Push** — `git push -u origin <branch>`.
7. **Open the PR** — `gh pr create` with summary bullets and a test plan
   checklist, using `.github/pull_request_template.md`.
8. **Watch checks** — `gh pr checks <number> --watch`.
9. **Address feedback** — fix CI and review findings, then re-watch until all
   required checks are green.
10. **Merge** — `gh pr merge --squash --delete-branch`, only once required
    checks pass. Never use `--admin` or `--force` to bypass branch protections.
11. **Post-merge deploy** — pushing to `main` triggers path-filtered deploy
    workflows. Do not run manual deploy commands after a merge unless you are
    recovering from an incident.

### Branch Naming

| Type | Prefix |
|---|---|
| Feature | `feat/<description>` |
| Refactor | `refactor/<description>` |
| Bug fix | `fix/<description>` |
| Docs | `docs/<description>` |
| Enhancement | `enhance/<description>` |
| Chore | `chore/<description>` |

### Commit Format

```text
<type>: <short description>

<body explaining why, not what>
```

## Deployment Rule

Deployments run on the VPS over SSH/Tailscale, never from a local Mac.

- **Canonical (VPS/CI):** `bash scripts/deploy.sh <service> prod` — works
  everywhere, no `make` required.
- **Convenience (local Mac):** `make deploy-<service>` — thin wrappers around
  the scripts above.

For manual VPS access, see [docs/runbooks/deployment.md](docs/runbooks/deployment.md).

## Command Map

`make` targets are convenience wrappers for local use. On the VPS or in CI, use
the script form directly.

| Operation | Script (canonical) | Make (convenience) |
|-----------|-------------------|--------------------|
| Recreate VPS | `bash scripts/vps.sh recreate` | `make recreate-vps` |
| Configure VPS | `bash scripts/vps.sh config <ip>` | `make config-vps VPS_IP=<ip>` |
| Bring up locally | `bash scripts/local.sh up` | — |
| Local health | `bash scripts/local.sh health` | — |
| Local teardown | `bash scripts/local.sh down` | — |
| Local reset (destructive) | `bash scripts/local.sh reset` | — |
| Deploy infra | `bash scripts/deploy.sh infra prod` | `make deploy-infra` |
| Teardown a stack | `bash scripts/deploy.sh teardown <stack> prod` | — |
| Deploy vault | `bash scripts/deploy.sh vault prod` | `make deploy-vault` |
| Deploy observability | `bash scripts/deploy.sh observability prod` | `make deploy-observability` |
| Health check | `bash scripts/ops.sh health` | `make health` |
| Backup all | `bash scripts/backup.sh backup-all` | `make backup` |
| Backup service | `bash scripts/backup.sh backup <svc>` | `make backup-<svc>` |
| List backups | `bash scripts/backup.sh list` | `make backup-list` |
| Prune backups | `bash scripts/backup.sh prune [days]` | `make backup-prune` |
| Rollback service | `bash scripts/rollback.sh rollback <svc> [ref]` | `make rollback SERVICE=<svc>` |
| Classify changes | `bash scripts/rollback.sh classify <svc> [ref]` | `make rollback-classify SERVICE=<svc>` |
| View secret | `bash scripts/secrets.sh view infra/secrets/prod.enc.env <key>` | `make secrets-view KEY=<key>` |
| Get secret (raw) | `bash scripts/secrets.sh get infra/secrets/prod.enc.env <key>` | `make secrets-get KEY=<key>` |
| Update secret | `bash scripts/secrets.sh update infra/secrets/prod.enc.env <key> <val>` | `make secrets-update KEY=<key> VALUE=<v>` |
| Vault init | `bash scripts/vault.sh init` | `make vault-init` |
| Vault unseal | `bash scripts/vault.sh unseal` | `make vault-unseal` |
| Vault status | `bash scripts/vault.sh status` | `make vault-status` |
| Vault setup | `bash scripts/vault.sh setup` | `make vault-setup` |
| Vault seed | `bash scripts/vault.sh seed` | `make vault-seed` |
| Vault sync to SOPS | `bash scripts/vault.sh sync-to-sops` | `make vault-sync-to-sops` |
| Vault auto-unseal | `bash scripts/vault.sh auto-unseal` | `make vault-auto-unseal` |
| Vault setup sync token | `bash scripts/vault.sh setup-sync-token` | `make vault-setup-sync-token` |
| Vault bootstrap AppRoles | `bash scripts/vault.sh bootstrap-approles` | `make vault-bootstrap-approles` |
| Check secrets schema | `python3 scripts/checks/check_secrets_schema.py` | `make check-secrets-schema` |

Vault-to-SOPS sync also runs as the `vault-sync-to-sops` GitHub Actions
workflow, on a weekly schedule or manual trigger.

## Reference Map

**Runbooks**

- [Local development](docs/runbooks/local-development.md)
- [VPS rebuild](docs/runbooks/vps-rebuild.md)
- [Disaster recovery](docs/runbooks/disaster-recovery.md)
- [Deployment](docs/runbooks/deployment.md)
- [Secrets workflow](docs/runbooks/secrets-workflow.md)
- [Secrets schema validation](docs/runbooks/secrets-schema-validation.md)
- [Vault auto-unseal](docs/runbooks/vault-unseal.md)
- [Observability](docs/runbooks/observability.md)

**Architecture**

- [Overview](docs/architecture/overview.md)
- [Secrets model](docs/architecture/secrets-model.md)

**Operational reference**

- [Deployment architecture](docs/reference/deployment.md)
- [GitHub Actions automation](docs/reference/github-actions.md)
- [VPS operations](docs/reference/vps-operations.md)
- [DNS management](docs/reference/dns.md)
- [Secrets management](docs/reference/secrets.md)
- [Tailscale management](docs/reference/tailscale.md)

## Guardrails

**Do**

- Validate behavior locally before opening a PR.
- Use `bash scripts/*.sh` or the `make` wrappers for operations.

**Don't**

- Run deploy scripts locally on a Mac.
- Use `gh pr merge --admin` or `gh pr merge --force`.
- Run long-running local dev servers (`npm run dev`, `npm start`, `pnpm dev`)
  unless you actually need one.
- Skip CI or review feedback.

### Verify the Instrument Before You Believe the Verdict

**An instrument that cannot see the thing is not evidence that the thing is absent.**
Blindness and absence produce identical output — an empty list, a zero, a silent grep —
and nothing in that output tells you which one you got.

This is not a maxim. It is the single most common defect found on 2026-07-31, and it
appeared **six times in one day wearing six different coats**:

| The check said | What was actually true |
|---|---|
| `strings` on Alertmanager's log: no matches → *"the log is empty"* | **`strings` was not installed.** The command produced nothing because it did not exist. The file was 123 bytes and non-empty. |
| `/api/v2/alerts`: `0 alerts` → *"nothing has ever fired"* | That endpoint reports **currently active** alerts, and Alertmanager had restarted minutes earlier. It answers "what is firing now", never "what has fired". |
| `du` over `/var/lib/docker/*/` → *"the directory is empty"* | The glob expanded **as an unprivileged user** against a root-only directory and matched nothing. `sudo` returned 26 GiB. |
| the tenancy contract: *"`cadvisor` scrapes all containers"* | cAdvisor emits **zero Docker container series** here — 45 cgroup and systemd series, `count(container_memory_usage_bytes{name!=""})` = 0. A documented guarantee resting on a blind instrument. |
| `amtool check-config`: **SUCCESS** | Every notification then failed at *render* time — `default` is not an Alertmanager template function. A **green verdict** from an instrument that could not see the failure. |
| an exact-match sweep for `blackbox` → *"container missing"* | The container is named `blackbox-exporter`. It was running the whole time. |
| decoding a token from `admin-cli`: no `sub`, no `realm_access` → *"the user has no roles"* | **`admin-cli` issues a LIGHTWEIGHT access token.** The token is valid — it returned `200` from every admin endpoint — because Keycloak resolves permissions server-side from the session, not from claims. Fine for probing permissions; blind for inspecting claims. Use an authorization-code flow through a real client. |

Three more from the tenant the same week: `ls -l` hiding a dotfile read as *"the file is
absent"*; a `grep` for a compose warning whose quotes were backslash-escaped read as
*"compose is silent"*; `wc -l` on a mistyped `mc` alias read as *"zero objects"*.

**The defence is a positive control: run the check against a case whose answer you already
know, and confirm it produces a result, before believing it when it produces none.**

- `check_alert_series.py` earns its trust by independently rediscovering the two rules
  already known to be unfireable. If it stops finding those, it has gone blind.
- Before reporting "no objects in the bucket", put one there and see it.
- Before reporting a container missing, list all of them and read the names.
- `promtool test` cannot prove a rule can fire — the test author supplies the labels. Only
  the live series check can. Neither is sufficient alone.

Two habits that cost nothing:

- **Say "not recorded", never "did not happen"**, when the recording only started recently.
  Keycloak's event log is the standing example: an empty result for a past date means
  nothing was writing then.
- **Check the exit code of the thing you meant**, not of the pipeline. `cmd | tail; echo $?`
  reports `tail`'s status — which read as "the check passed" for a script that exited 1.

The fuller instance-by-instance record, including the checks that were wrong *about the
alert rules themselves*, is in
[`docs/decisions/alert-series-verification.md`](docs/decisions/alert-series-verification.md).

#### When to doubt the instrument: the dangerous null is the one that agrees with you

The section above says to check the instrument. This says **when**, because you cannot
positive-control everything and the budget has to go somewhere.

**Spend it on the results you were hoping for.** A null that blocks you gets investigated
by reflex — you wanted the thing and it is not there, so you go looking. A null that
*confirms* you stops the investigation, which is exactly when nobody looks again. Every
false result recorded on 2026-08-03 was of the second kind:

| The convenient result | What it actually was |
|---|---|
| a mock counter reporting clean | it **double-counted**, so a real imbalance read as balanced |
| a global `jest.fn` hook reporting no interference | it intercepted **0 mocks** — the pool mock is created inside each file's factory, where a global hook cannot see it |
| a byte recorder capturing nothing untoward | it read **only three digits** of the status line |
| `grep` for a test file in the CI log: **0 lines** → *"it did not run"* | bats TAP prints test **names**, never file names. The file had run; the pattern could never have matched either way |
| an audit reporting `VAULT_CONTAINER` and `TRAEFIK_CONFIG_OUTPUT` are read by no script | the audit's own pattern was wrong. Both are read, on the first line of two scripts |
| `assert-unsealed` "verified against the live estate" | the host checkout was **one commit behind**, so the verification ran against the code the change replaced — and the passing half of the test passed identically under both |

The last one is the sharpest, because it looked like success twice over: the command exited
0, and 0 was the expected answer. Only the *other* arm — the one that was supposed to
change — exposed that nothing had been deployed.

The app repo's flake investigation reached the same conclusion independently and states it
as a measurement rather than an aphorism: **every check in that file that reported a clean
result was wrong at least once until it was positive-controlled**
([`api-suite-flakiness.md`](https://github.com/jonhill90/hill90-app/blob/main/docs/decisions/api-suite-flakiness.md)).

Two questions that cost nothing and catch most of it:

- **"What would this look like if the instrument were broken?"** If the answer is "the same
  as what I am looking at", you have not measured anything yet.
- **"Which arm of this test would have changed?"** A check whose passing half passes under
  both the old and new behaviour has told you nothing about the change.

### The Other Half: An Operation That Fails and Reports Success

The section above is about a **check** that cannot see. This one is about an
**operation** that does not happen and says it did. Same family, opposite end: there
the verdict was green because nothing was measured; here the verdict is green because
nothing was *done*, and the failure is invisible precisely to whoever is watching for it.

**2026-08-03 produced a 43-minute auth outage and a Grafana SSO breakage, and both were
this.** Five instances were found and closed in one day:

| The thing that "succeeded" | What actually happened |
|---|---|
| `vault_load_secrets` on a **403** | Returned success with nothing loaded. Keycloak deployed with `KC_ADMIN_PASSWORD` empty, restart-looped, and took SSO down for 43 minutes. Fixed in #651. |
| A service with **no declared vault paths** | `return 0` — "loaded nothing, successfully". Every unlisted service took this path on every deploy. `minio` survived only because its compose file writes `${MINIO_ROOT_USER:?}`, a second guard doing the first one's job. Fixed in #655. |
| **Root-token revoke**, requested with `revoke_root_at_end=true` | Skipped, on exactly the runs that failed. A live root token sat on the production host. The shut-door assertion passed throughout — shutting the door and holding a key are different things. Fixed in #663. |
| A **pre-up hook that refused** | `render-alertmanager-config.sh` printed `Refusing to render the Alertmanager config` and the deploy went **green, twice**. The Alertmanager config silently stopped being re-rendered for two days. Fixed in #671. |
| A **partial vault load**, exported anyway | `vault: loaded 1 variables for observability, none empty` — true, and useless. `GRAFANA_OIDC_CLIENT_SECRET` was *absent*, not blank, so the empty-value guard found nothing wrong. Grafana started with an empty OIDC secret. Fixed in #672. |

#### The shell mechanism, plainly

**Four of those five were possible because `set -e` does not apply inside a compound
command on the left of `||`.** Every vault-first deploy is shaped like this:

```sh
( load_secrets_and_deploy ) || { fall_back_to_sops; }
```

Inside those parentheses, `set -e` is **suppressed**. A command that fails does not stop
the subshell; it prints its error and execution continues to the next line — which is
usually `docker compose up` with a half-populated environment. Three lines reproduce it:

```sh
set -e; f() { return 1; }
( f; echo "still running" ) || echo "fallback"   # -> still running
( f || exit 1; echo x )     || echo "fallback"   # -> fallback
```

`exit` is not subject to the suppression. `return`, and a bare call, are.

The same rule has a second face in GitHub Actions. **A custom `if:` on a step does not
replace the implicit `success()`; it is ANDed with it** unless the expression names
`always()`, `failure()` or `cancelled()`. So `if: ${{ inputs.revoke_root_at_end }}` runs
only when nothing has failed — the inverse of what a cleanup step is for.

#### What to do about it

- **Every call inside a `( ... ) || fallback` subshell needs `|| exit 1`.** Not the
  functions — the call sites. `tests/scripts/pre-up-hook-aborts-control.bats` pins this,
  and demonstrates the bug and the fix rather than grepping for the fix.
- **Every cleanup step in a workflow needs `always() &&`**, and an assertion afterwards
  that it actually happened. `scripts/checks/check_root_revoke_fails_closed.py` simulates
  a failure at each step and requires the revoke to still be reachable.
- **"Succeeded" must mean the postcondition holds, not that the command returned.**
  `loaded N variables, none empty` described what arrived, never what was needed. Assert
  against a declared requirement — see `vault_required_vars_for_service`.
- **A guard whose failure is ignored is worse than no guard**, because it reads as
  coverage in review. If you add one, add the test that proves the caller propagates it.
- **Distinguish absent from blank.** They need separate checks and produce the identical
  empty string in a container.

#### Positive controls apply here too, in mirror image

For a blind check you prove it can see. For a silent success you **make the operation fail
on purpose and confirm something stops.** Both halves of that were done live on
2026-08-03: `chattr +i` on the Alertmanager output made the pre-up hook fail, and the
deploy went red where the identical condition had gone green hours earlier.

Reach for the induced failure that the guard is *supposed* to catch, and check you are
failing for the reason you meant — a first attempt used `chmod 000` on the template, which
git reported as a modified file, so the deploy would have failed at the checkout preflight
instead and proved nothing.

### Manual Workarounds Are a Merge Blocker

If verifying a PR required an ad-hoc manual workaround — `chmod`/`chown`,
direct container edits, one-off env var injection, temporary DNS or network
changes, direct DB mutation outside documented recovery procedures, or
vault/container changes not represented in code, automation, or runbooks —
treat the PR as blocked by default. Documented runbook-backed operations (for
example `vault.sh unseal`) are not workarounds.

Before merging: identify the root cause, determine the least-privilege durable
fix, and pick one of:

- **Patch first** (default) — fix the root cause in this PR before merge.
- **Split follow-up** — permitted only when all of: (a) the current changes are
  safe to ship independently, (b) the workaround does not weaken security
  posture, and (c) the workaround does not break on redeploy. File the
  follow-up issue immediately and link it in the PR body.
- **Merge now** — permitted only when the supposed workaround turned out to be
  unnecessary, or the durable fix is already in the PR.

## What the archive tags preserve, and what they do not

`archive/app-stack-final` points at `f03f12d`, which **is an ancestor of `main`**. It
preserves the state of the mainline immediately before the strip — it does not preserve
anything that never reached the mainline. `hill90-app` was extracted from that same
commit, so it carries the identical blind spot.

**Both archives are complete for *merged* work and empty for *unmerged* work.** That is
the correct expectation to hold about them.

*(Measured during the 2026-07-26 branch audit, which covered 168 remote branches. That
audit's inventory is spent — the repository carries 25 today — but this property of the
tags is not, so it is recorded here rather than left to die with the audit.)*

## Dated claims: state what becomes true, not that the date is coming

A future-tense sentence about a date reads as *not yet due* forever, so it fails silently
the moment it passes. Worse, a `Verified <timestamp>` on one is misleading **in both
directions at once**: it certifies when the claim was checked, while the sentence describes
a moment that has since arrived.

Write `expired 2026-08-01 01:41 UTC; after that it is an untaken decision` rather than
`expires 2026-08-01 01:41 UTC`. The first is true before **and** after; the second is only
true before.

Found on 2026-08-03 by sweeping both repos: 2 instances in 107 markdown files, both the same
`app-minio` retention window. Rare, not systemic — which is why this is a convention and not
a CI check.
