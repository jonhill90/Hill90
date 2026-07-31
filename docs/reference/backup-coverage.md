# Backup coverage — what is in the nightly set, and what a gap costs

What `scripts/backup.sh backup-all` actually covers, volume by volume, and for each
thing it does not cover, what is lost if the host disappears tonight.

`Verified 2026-07-31 08:12 UTC` — volume list, container list and mount ownership read
from the VPS read-only (`docker volume ls`, `docker ps`, `docker ps --filter volume=`).

## The schedule

From the `deploy` user's crontab on the VPS, installed by Ansible:

```
0 3 * * *    cd /opt/hill90/app && SOPS_AGE_KEY_FILE=... bash scripts/backup.sh backup-all
0 4 * * 0    cd /opt/hill90/app && bash scripts/backup.sh prune 7
```

Nightly at 03:00 UTC, pruned to 7 days on Sundays at 04:00. Output appends to
`/opt/hill90/backups/cron.log`. Backups live on the **same host they protect** — there is
no offsite copy, so this set survives a bad deploy, a dropped table or a corrupted volume,
and does not survive losing the VPS.

## Covered

Eight named volumes, across six targets.

| Target | Volume | Also has a consistent artifact? |
|---|---|---|
| `db` | `prod_postgres-data` | **Yes** — `pg_dumpall`, and the dump is required for the run to pass |
| `app-db` | `prod_app-postgres-data` | No longer — the container is retired, so the tar is all that is left |
| `minio` | `prod_minio-data` | No |
| `vault` | `openbao-data` | No |
| `infra` | `prod_traefik-certs`, `prod_portainer-data` | No |
| `observability` | `grafana-data`, `prometheus-data` | No |

Every one of those tars is **crash-consistent at best** — see
[the caveat in `backup_volume`](../../scripts/backup.sh). `db` is the only target with a
second artifact that restores cleanly, which makes it the least exposed, not the most.

**Whether that is worth fixing was worked out per volume, and mostly it is not** —
[`backup-consistency-options.md`](../decisions/backup-consistency-options.md). Summarised,
because the sizes above mislead about what is actually at stake:

| Volume | What it protects that git + SOPS cannot rebuild | Fix it? |
|---|---|---|
| `prod_postgres-data` | Everything in Postgres | Already fixed — `pg_dumpall` |
| `prod_app-postgres-data` | The retired tenant database | Not needed — **no container references this volume**, so with no writer the tar is a clean copy, not a crash-consistent one |
| `prod_minio-data` | **Object data — the only such state here** | Not at 112 KB. Revisit when it grows |
| `openbao-data` | Nothing — DR re-seeds from SOPS | **No fix exists**: snapshots need Raft, this is `file` storage |
| `prod_traefik-certs` | Only ACME rate-limit headroom | No — stopping Traefik downs the whole edge |
| `prod_portainer-data` | 1 MB of UI state | No — free to do, nothing to protect |
| `grafana-data` | **One OAuth user row** (measured) | No — dashboards and datasources come from provisioning |
| `prometheus-data` | 7 days of metrics | No — the snapshot API would also enable series deletion |

## Not covered — and what each gap costs

| Volume | Owner | Size | Consequence if the host is lost |
|---|---|---|---|
| `loki-data` | `loki` | 59.3 MB | All retained logs. Nothing else holds them; log history is gone for good. Accepted: logs are diagnostic, and a rebuilt estate starts a fresh window. |
| `tempo-data` | `tempo` | 39.9 MB | All retained traces. Same reasoning as Loki. |
| `promtail-positions` | `promtail` | small | Read offsets only. Rebuilds itself; losing it re-ships or skips a little log tail. **No real cost.** |
| `prod_app-akm-data` | `app-knowledge` | 4 KB (one empty `agents/` directory) | The tenant's knowledge store. **Empty today, so the cost today is nil — and that is exactly why this is worth writing down.** The gap is invisible while the volume is empty and becomes a silent data-loss path the moment the tenant starts storing knowledge. |
| `prod_app-akm-keys` | `app-ai`, `app-knowledge` | 8 KB (`public.pem`, `model-router-public.pem`) | Public keys only, regenerable from their private counterparts. Low cost — but confirm that assumption before the private halves move. |
| `prod_app-minio-data` | `app-minio` (stopped 2026-07-31 01:40:43 UTC) | — | The retired tenant object store, kept as a safety net until its retention expires **2026-08-01 01:41 UTC**. Nothing backs up the safety net. Whether its contents are fully represented in the platform MinIO has **not** been checked here, so do not assume the gap is harmless — and note that "retained" and "backed up" are being conflated if this is not said out loud. |
| 9 anonymous container volumes | assorted | — | Docker-generated, no declared state. |
| `/opt/hill90/secrets/` | host path, not a volume | — | The age key and the OpenBao unseal key. **In no tar, by design** — see below. |
| `/opt/hill90/agentbox-configs` | host path, not a volume | — | Already recorded in `docs/runbooks/deployment.md`; outside every checkout and every tar. |

A structural note on the last two: `backup_volume` tars **Docker volumes**. Anything that
lives on a host path is outside the mechanism entirely, so no amount of adding targets
reaches it.

### The observability asymmetry

`prometheus-data` is backed up nightly (239 MB on 2026-07-31); `loki-data` and
`tempo-data` are not. That is inconsistent, and it is not obviously wrong — metrics feed
alert history that has more value than raw logs — but it is not a decision anybody
recorded. Treat it as unexamined rather than settled.

## The age key is deliberately in no backup

`/opt/hill90/secrets/` holds `openbao-unseal.key` and `keys/keys.txt`, the age private
key. Neither is in any tar, and neither should be: a backup that contains the key which
decrypts the rest of the estate is a backup you cannot store anywhere.

The consequence is a hard ordering constraint on recovery, written out in
[`disaster-recovery.md`](../runbooks/disaster-recovery.md#step-0). The short version: the
**vault tar is inert without the age key**, and the first step of a rebuild happens in a
password manager, not on the host.

`OPENBAO_UNSEAL_KEY` is present in `infra/secrets/prod.enc.env`, which is committed —
confirmed 2026-07-31 by reading the key name from the encrypted file, whose dotenv format
keeps names in plaintext and values as ciphertext. The value was never decrypted or
printed. So the unseal key is not a single point of failure; **the age key is.**
