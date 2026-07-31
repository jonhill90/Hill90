# Deployment Runbook

Standard deployment process for Hill90 on the Hostinger VPS.

## Prerequisites

- Access to the VPS over Tailscale (`remote.hill90.com` or `<tailscale-ip>`).
- Age key present on VPS at `/opt/hill90/secrets/keys/keys.txt`.
- Encrypted secrets file available in repo (`infra/secrets/prod.enc.env`).

## Deploy Infrastructure

```bash
make deploy-infra
```

Expected outcome:
- `traefik` and `portainer` containers are healthy.
- `hill90_edge` and `hill90_internal` Docker networks exist.
- DNS-01 certificate flow is functional for Tailscale-only routes.

## Deploy Vault

```bash
make deploy-vault
```

Expected outcome:
- `openbao` container starts on edge and internal networks.
- `vault.sh auto-unseal` runs automatically after compose up.
- Vault is initialized and unsealed (status: `sealed:false`).
- On VPS reboot, the `hill90-vault-unseal` systemd service auto-unseals within ~60 seconds.

See [Vault Unseal Runbook](./vault-unseal.md) for troubleshooting.

## Deploy Observability

```bash
bash scripts/deploy.sh observability prod   # canonical (VPS/CI)
make deploy-observability                    # convenience (local Mac)
```

Expected outcome:
- 7 containers healthy: `prometheus`, `grafana`, `loki`, `tempo`, `promtail`, `node-exporter`, `cadvisor`.
- Grafana accessible at `https://grafana.hill90.com` (Tailscale-only).
- Prometheus scrape targets all show `up`.

## Validate Deployment

```bash
make health
make dns-verify
```

Optional targeted checks:

```bash
make logs-traefik
bash scripts/deploy.sh verify infra
bash scripts/deploy.sh verify observability

# Tailscale-only surfaces:
curl -f https://traefik.hill90.com/ping
curl -f https://grafana.hill90.com/api/health
```

## SSH-Based Deployment (On VPS)

```bash
ssh -i ~/.ssh/remote.hill90.com deploy@remote.hill90.com \
  'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh infra prod && bash scripts/deploy.sh vault prod && bash scripts/deploy.sh observability prod'
```

## Stack-Level Project Isolation

All Docker Compose operations use explicit project names to prevent cross-stack interference:

| Stack | Project Name | Services |
|-------|-------------|----------|
| edge | `hill90-prod-edge` | traefik, portainer |
| platform | `hill90-prod-platform` | openbao |
| apps | `hill90-prod-apps` | api, ai, mcp, ui |
| observability | `hill90-prod-observability` | prometheus, grafana, loki, tempo, promtail, node-exporter, cadvisor |

### Operational Invariants

1. **No `--remove-orphans`** — banned globally in all scripts and workflows.
2. **All `docker compose` calls use explicit `-p <project>`** — no implicit project names.
3. **Stateless apps use `up -d --force-recreate --no-deps`** — no `down` step, zero-downtime replacement.
4. **Edge deploy is manual-only** — never auto-triggered by push.
5. **No local VPS file edits** — all changes go through git + CI. See
   [Hand-edits on `/opt/hill90/app` are doomed by construction](#hand-edits-on-opthill90app-are-doomed-by-construction)
   for why this is a mechanism rather than a preference.

### Hand-edits on `/opt/hill90/app` are doomed by construction

Every deploy path in this repository runs `git reset --hard origin/main` on the
VPS checkout — `deploy-infra.yml`, `reusable-deploy-service.yml`,
`vault-init.yml` and `vault-reinitialize.yml` all do it. **Any uncommitted change
under `/opt/hill90/app` is therefore destroyed by the next deploy**, and it is
not recoverable: unstaged changes are never written to git's object database, so
there is no blob, no stash and no reflog entry to restore from.

Land a hand-edit in the repository the same day, or accept that it will vanish
without a trace and without a warning.

**Some of those paths are live.** `platform/edge/dynamic` is bind-mounted into
Traefik at `/etc/traefik/dynamic` with `watch: true`, so editing a file there is
simultaneously a **live production change** and a doomed one — Traefik reloads
it within seconds, and the next deploy silently reverts it. Ten further paths
(the Keycloak realm and theme, the Postgres init script, the observability
configs, the vault policies) are bind-mounted without `watch`, so an edit is
visible in the container immediately and takes effect at its next restart.

A dirty tree under `docs/` is untidy. A dirty tree under `platform/edge/dynamic`
is an undocumented live production change about to be reverted without review.

> **Live as of 2026-07-29 07:45 UTC: the VPS checkout does not yet have this
> script.** `/opt/hill90/app` is at `b50b3a1` (#563) and two commits behind, so
> `bash scripts/preflight-checkout.sh` will exit 127 and — because the deploy
> chains with `&&` — **the next deploy will halt rather than run unguarded.**
> That is the safe direction, but it needs one `git pull` on the box first. The
> preflight lives in the checkout it validates, so this is a one-time bootstrap
> cost, not a recurring one.

`scripts/preflight-checkout.sh` runs before every reset and enforces this: on a
dirty tree it prints the full diff — the only record that will survive — labels
each path by how live it is, and refuses. Override with
`ALLOW_DIRTY_CHECKOUT=1` when the discard is genuinely intended.

The tenant has the same hazard on `/opt/hill90-app` and no guard yet; the
analysis, including the finding that nothing there is live-watched, is in
[`docs/decisions/tenant-checkout-hazard.md`](../decisions/tenant-checkout-hazard.md).

It also reports **drift**: how many commits the checkout is behind `origin/main`.
On 2026-07-29 the checkout was found 12 commits behind and locally modified, so
production had been running configuration that differed from the repository for
three days with no signal. That is the case the drift report exists to surface.

### Inspecting Stacks

```bash
docker compose -p hill90-prod-edge ps          # Edge services
docker compose -p hill90-prod-platform ps       # Database + storage
docker compose -p hill90-prod-identity ps       # Auth
docker compose -p hill90-prod-apps ps           # App services
docker compose -p hill90-prod-observability ps  # Monitoring
```

## Pre-Deploy Backups

Stateful deploys (vault, observability) automatically create a backup before the deploy cycle. Infrastructure deploys also back up traefik certificates and portainer data.

Backups are stored at `/opt/hill90/backups/<service>/<timestamp>/` on the VPS.

### Scheduled Backups

A daily cron job runs `backup-all` at 03:00 UTC. Weekly prune at 04:00 Sunday
removes backups older than 7 days. Logs at `/opt/hill90/backups/cron.log`.

`backup-all` covers `db`, `app-db`, `vault`, `infra` and `observability`. It runs
every service even if one fails and then exits non-zero, so one absent service
does not cost the other four their backups — but the run still goes red.

Cron is configured by Ansible (`01-system-prep.yml`) during VPS bootstrap.
To verify on VPS: `crontab -l -u deploy | grep hill90`

### Manual Backup Commands

```bash
# Backup all critical volumes
make backup                    # or: bash scripts/backup.sh backup-all

# Backup a specific service
make backup-db                 # or: bash scripts/backup.sh backup db
bash scripts/backup.sh backup app-db   # the hill90-app tenant's database
make backup-vault              # or: bash scripts/backup.sh backup vault
make backup-infra              # or: bash scripts/backup.sh backup infra
make backup-observability      # or: bash scripts/backup.sh backup observability

# List available backups
make backup-list               # or: bash scripts/backup.sh list
bash scripts/backup.sh list db # List only db backups

# Prune old backups (default: 7-day retention)
make backup-prune              # or: bash scripts/backup.sh prune
bash scripts/backup.sh prune 14 # Keep 14 days instead

# Restore from backup
make backup-restore SERVICE=db BACKUP_PATH=/opt/hill90/backups/db/20260222_120000
```

### What changed on 2026-07-29, and why it matters

Two defects were found and fixed together (#563). Both had been true for days and
neither produced an error.

**The SQL dump had silently stopped running.** `/etc/crontab` sets
`PATH=/sbin:/bin:/usr/sbin:/usr/bin` and `sops` installs to `/usr/local/bin`, so
under cron the decrypt was *command not found*. Its stderr went to `/dev/null`,
`DB_USER` came back empty, the dump was skipped with a warning, the volume tar
still ran, and the job exited 0. Three consecutive nightly backups held a tar and
no `database.sql`. The same command worked by hand, which is why it survived.

**The tenant's database had never been backed up by anything.**
`prod_app-postgres-data` holds hill90-app's Keycloak realm and its user accounts,
AKM knowledge, chat history and LiteLLM data. This script knew only
`prod_postgres-data`, and hill90-app has no backup script of its own.

What is now different:

- `sops` is resolved by absolute path, not by `PATH` alone.
- A dump that cannot be taken is **fatal**, not a warning. A backup that reports
  success with no dump manufactures false confidence, which is worse than an
  error — the operator believes they have a restore path and does not.
- Artifacts are checked non-empty before success is reported. Two backup
  directories on this host were completely empty and had still counted as
  successful runs.
- `app-db` covers the tenant: a real `pg_dumpall` plus the volume tar.

**The restore is proven, not assumed.** On 2026-07-29 the tenant dump was
restored into a throwaway Postgres container and both user accounts came back
with their correct realm roles. That was the first restore this estate had ever
performed. Verified artifacts from that run:

| Artifact | Bytes |
|---|---|
| `/opt/hill90/backups/db/20260729_065934/database.sql` | 322,299 |
| `/opt/hill90/backups/app-db/20260729_065944/app-database.sql` | 532,513 |
| `/opt/hill90/backups/app-db/20260729_065944/app-postgres-data.tar.gz` | 17,347,196 |

A tar of a live `PGDATA` is crash-consistent at best; the `pg_dumpall` is the
artifact that restores cleanly. Both are taken and the dump is required.

Not covered by any backup: object storage, agent state, and
`/opt/hill90/agentbox-configs`, which is a host path outside every checkout.

### What Gets Backed Up

| Service | Backup Method | Files |
|---------|--------------|-------|
| vault | Volume tar | `openbao-data.tar.gz` |
| infra | Volume tar | `traefik-certs.tar.gz`, `portainer-data.tar.gz` |
| observability | Volume tar | `grafana-data.tar.gz`, `prometheus-data.tar.gz` |

### Restore Procedure

1. Stop the target service: `make down-<service>`
2. Restore: `make backup-restore SERVICE=<service> BACKUP_PATH=<path>`
3. Restart: `docker restart <container>`
4. Verify: `bash scripts/deploy.sh verify <service>`

## Rollback

The rollback script classifies changes and applies the appropriate strategy.

### Change Classes

| Class | Services | Strategy | Automated? |
|-------|----------|----------|------------|
| **code-only** | api, ai, mcp, ui | Checkout previous source, redeploy | Yes |
| **config-only** | auth, infra, observability | Checkout previous config, redeploy | Yes |
| **schema-forward** | db (when migrations change) | Restore from backup, then rollback code | Manual |
| **mixed** | any | Review, then rollback | Yes (with review) |

### Rollback Commands

```bash
# Classify changes before rolling back (read-only, safe)
bash scripts/rollback.sh classify api HEAD~1
make rollback-classify SERVICE=api REF=HEAD~1

# Automated rollback (code-only or config-only)
bash scripts/rollback.sh rollback api HEAD~1
make rollback SERVICE=api REF=HEAD~1

# After rollback, redeploy and verify
bash scripts/deploy.sh observability prod
bash scripts/deploy.sh verify api
```

### Schema-Forward Rollback (Manual)

When the rollback script detects migration files, it refuses automated rollback and prints manual restore instructions:

1. Restore the database from the pre-deploy backup
2. Checkout the previous code
3. Redeploy both db and the app service
4. Verify health

### DB Migration Compatibility Policy

- All DB migrations must be backward-compatible with the previous application version
- Destructive schema changes (drop column, rename table) require two phases: deprecate first, remove in a subsequent release
- Pre-deploy backup is mandatory before any schema migration (enforced by deploy script)

### General Rollback Guidance

- If a service deploy fails, use `rollback.sh classify` to understand the change, then `rollback.sh rollback` or manual restore
- If infrastructure is unstable, rerun `make deploy-infra` before app redeploy
- For catastrophic failure, use the VPS rebuild flow in `docs/runbooks/vps-rebuild.md`

## Persistent Volume Safety Invariants

Stateful services (traefik, portainer, openbao, observability) store data in Docker volumes. These invariants prevent data loss from volume namespace drift.

### Rules

1. **All compose volumes for stateful services must use explicit `name:` fields.** Without an explicit name, Docker Compose prepends the project name — if the project name changes, services silently mount new empty volumes while old data volumes remain disconnected.

2. **Never change compose project names or volume keys without a migration plan.** If a rename is unavoidable, pin volumes with `name:` first, verify mounts post-deploy, and document the migration.

### Banned Commands for Routine Operations

These commands destroy volume data and must never appear in deploy scripts or workflows:

- `docker compose down -v` — removes named volumes
- `docker volume rm` — deletes volumes directly
- `docker system prune` — may remove unused volumes

CI enforces this ban via the `Validate Repository` workflow (`ci.yml`).

### Pre-Change Backup

Before any compose file change that touches volumes or project names:

```bash
docker run --rm -v <volume>:/src -v /opt/hill90/backups:/backup alpine \
  tar czf /backup/<volume>.tar.gz -C /src .
```

### Post-Change Mount Verification

After deploying, confirm each container mounts the expected volume:

```bash
docker inspect <container> --format \
  '{{range .Mounts}}{{if eq .Destination "<path>"}}{{.Name}}{{end}}{{end}}'
```

Expected outputs:
- traefik (`/letsencrypt`): `prod_traefik-certs`
- portainer (`/data`): `prod_portainer-data`

### Rollback

If a volume name change causes data loss:

1. Revert the `name:` field in the compose file
2. Redeploy the affected stack
3. If the original volume was deleted, restore from tar backup:
   ```bash
   docker volume create <volume-name>
   docker run --rm -v <volume-name>:/dest -v /opt/hill90/backups:/backup alpine \
     tar xzf /backup/<volume-name>.tar.gz -C /dest
   ```

## Secrets and the shells that do not have them

**The rule: any `deploy.sh` code path that reads a compose file or a secret must run
inside the secret environment.**

Four bugs in one week were this single mistake in four places. It is worth stating as a
rule because each instance looked like a different problem, and three of them blamed
something that was working correctly.

### Why it keeps happening

Service secrets exist only inside a `sops exec-env` child process or a
`vault_load_secrets` subshell. Anything else sees them as empty:

- a bare `ssh ... deploy.sh verify <svc>` — the workflow invokes verify with no wrapper
- any line **after** the subshell closes, including the completion banner
- a function that never loads secrets at all, such as `cmd_teardown`
- a guard that runs **before** the load, such as the auth pre-deploy database check

Bash does not object to an empty variable. So the failure appears somewhere unrelated,
and the error message names the wrong cause.

### Compose interpolates for EVERY subcommand

Not just `up`. `ps`, `config` and **`down`** all interpolate the compose file first.
That is what made `deploy.sh teardown minio` impossible: it fails **after** the
pre-teardown backup has run and **after** printing `Volumes: KEPT — data survives`,
which reads like success.

`docker-compose.minio.yml` is currently the only prod compose file using the required
form `${VAR:?...}`. That is why MinIO is where this keeps surfacing — everywhere else
the identical mistake interpolates to empty and says nothing at all. **Do not treat the
other stacks as safe; treat them as not yet noisy.**

### What to do instead

| Need | Do |
|---|---|
| Run compose (`up`/`down`/`config`) | Wrap in `sops exec-env`, with `set -e` **inside** the string |
| Print container status | `docker ps --filter label=com.docker.compose.project=<project>` — no interpolation, no secret |
| One value, outside a secret scope | `secret_value VAR [env]` from `_common.sh` |
| A value that cannot be resolved | State the assumption with `warn`, or `die`. **Never** silently substitute a literal |
| Write a credential to a file | Check it is non-empty first. An empty write is a lockout that looks like a success |

`sops exec-env` runs a **new shell that does not inherit `set -e`, and returns 0
regardless of what the command did.** Always put `set -e` inside the quoted string, or a
failed deploy reports success.

### Reporting rule

A check that could not run must never report failure of the thing it was checking.
`validate.sh compose` reported `docker-compose.minio.yml ✗ Invalid` for a perfectly
valid file — and suggested a command that failed the same way. It now distinguishes
validated, validated-with-secrets, and `⚠ needs secrets — NOT validated`.

### Known remaining instances

None in `deploy.sh` as of 2026-07-31. The audit that found them is recorded in
[object-store.md](../decisions/object-store.md); `scripts/checks/minio-readiness-test.sh`
asserts the fixed shape so they cannot silently return.

## Failure Modes

- Missing or invalid secrets: `sops`/runtime env errors at deploy time.
- Missing Docker networks: vault and observability deploys fail until `make deploy-infra` recreates them.
- ACME rate limiting: switch to staged testing cadence and retry after cooldown.

## See Also

- [Deployment Architecture Reference](../reference/deployment.md) — compose files, workflows, and architecture details
- [Troubleshooting Guide](./troubleshooting.md) — common issues and fixes
