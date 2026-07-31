# Making the volume tars consistent — what it would cost, per volume

`backup_volume` tars a running container's volume with no stop, pause or freeze, so every
tar is crash-consistent at best (#610). This is the follow-up question: **can that be
fixed, per service, and is it worth fixing?**

The candidates genuinely differ per service, so this is eight separate decisions rather
than one mechanism.

`Verified 2026-07-31 08:26 UTC` — everything below was measured against production
read-only, except one throwaway container described in full at the end.

## The finding that governs every row

**This estate is largely declarative, so the volume tars protect much less than their size
suggests.**

- Grafana's dashboards and datasources are **provisioned from files in this repository**,
  bind-mounted at `/etc/grafana/provisioning`.
- OpenBao is re-initialised and re-seeded **from SOPS** by disaster-recovery steps 4–8.
  SOPS is the operative store; the vault is a secondary copy.
- Traefik's certificates **re-issue from ACME**.
- Prometheus, Loki and Tempo hold time-series and logs that are worthless once the window
  they cover has passed.

That leaves exactly two categories of genuinely irreplaceable state: **Postgres**, which
already has a consistent artifact (`pg_dumpall`), and **object storage**, which is 112 KB
today.

So the honest headline is: **consistency machinery buys very little here, and for most of
these volumes adding it would be worse than the risk it removes.**

## Per volume

| Volume | Consistent method available? | Cost | Verdict |
|---|---|---|---|
| `prod_postgres-data` (103 MB) | **Already have one** — `pg_dumpall`, required for the run to pass | none, already paid | **Solved.** The tar is a bonus artifact next to a consistent one |
| `prod_app-postgres-data` (102.5 MB) | **Not needed** — no container references this volume at all any more | none | **Consistent by construction.** A tar of a volume with no writer is a clean copy, not a crash-consistent one |
| `grafana-data` (30.3 MB) | Yes — `sqlite3 .backup` / `VACUUM INTO` | one tool dependency, a few seconds | **Not worth it.** Measured below: what it protects is one OAuth user row |
| `openbao-data` (180 KB) | **No** — snapshots require Raft; this runs `file` | migrate to Raft, or stop-tar-start | **Do not.** Stop-tar-start swaps a rare torn tar for a routine sealed-vault risk |
| `prod_minio-data` (112 KB) | Yes — `mc mirror`, or stop-tar-start | credentials plus a mirror target | **Not now — but this is the one to watch.** The only irreplaceable non-Postgres state |
| `prod_traefik-certs` (148 KB) | Yes — stop-tar-start | stopping Traefik takes the **entire public surface** down | **Do not.** Blast radius is the whole edge; certificates re-issue anyway |
| `prod_portainer-data` (1 MB) | Yes — stop-tar-start | genuinely free; nothing depends on Portainer | **Cheapest available and still not worth doing** |
| `prometheus-data` (664.5 MB) | Yes — TSDB snapshot API | requires `--web.enable-admin-api`, which also enables **series deletion** | **Do not. This is the clearest case.** |

### `grafana-data` — the hypothesis was that this was the case that warranted fixing. It is not.

The reasoning was sound: SQLite, small, high-value, cheap to do properly, and the one thing
a Postgres restore does not cover. `sqlite3 .backup` really is strictly better than tarring
the file underneath a running process, and the tooling is available offline — `python:3.12-alpine`
is already on the host and Python's standard library ships SQLite with the backup API, so no
new image and no `apk add` at 03:00.

**The mechanism is fine. The value is not there.** Measured by starting Grafana 11.6.0 from
a completely **empty** volume against this repository's provisioning directory, and
comparing its database to the live one:

| Table | Live | Rebuilt from nothing |
|---|---|---|
| `dashboard` | 6 | **6** |
| `dashboard_provisioning` | 6 | **6** |
| `data_source` | 3 | **3** |
| `alert_rule` | 0 | 0 |
| `annotation` | 0 | 0 |
| `star` | 0 | 0 |
| `preferences` | 0 | 0 |
| `folder`, `playlist`, `team`, `api_key` | 0 | 0 |
| `user` | 2 | **1** |
| `user_auth_token` | 2 | 0 |

All six live dashboards carry a `dashboard_provisioning` row — none was created in the UI.
The entire delta is **one user row**, `jon@hill90.com`, created by OAuth against Keycloak
(`GF_AUTH_GENERIC_OAUTH_ENABLED`, with the login form disabled), plus two session tokens.
That user is recreated by the next SSO login; the tokens are worthless.

So a consistent `grafana.db` protects one row that regenerates itself on first sign-in. The
correct call is to **leave the tar as it is** and stop treating `grafana-data` as the
high-value volume — a conclusion the *size* of `grafana.db` actively misleads you toward.

> The `admin` user is not at risk either: `GF_SECURITY_ADMIN_USER` and
> `GF_SECURITY_ADMIN_PASSWORD` come from the environment, sourced from `GRAFANA_ADMIN_PASSWORD`
> in the encrypted store, so it is recreated on a fresh start.

### `openbao-data` — no snapshot exists for this backend, and the workaround is worse

`bao status` reports `Storage Type file`, and `config.hcl` declares `storage "file"`. The CLI
is explicit that snapshots belong to a different backend: `bao operator raft snapshot` is
documented as *"subcommands for operators interacting with the snapshot functionality of the
**integrated Raft storage backend**"*. There is no snapshot or export operation for `file`.
`bao operator migrate` exists but moves data **between backends with the server down** — it is
a migration tool, not a live snapshot.

That leaves two real options:

1. **Migrate to Raft**, which unlocks `raft snapshot save` — a genuine point-in-time backup
   from the running server. Already costed in
   [`vault-vs-sops.md`](vault-vs-sops.md), which notes it would be "strictly better" and
   simultaneously argues the vault should earn its place at all. **Do not do this for backup
   reasons alone.** It adds a peer port, node identity, autopilot and quorum semantics to a
   single-node vault holding three infrastructure secrets, and single-node Raft has a failure
   tolerance of zero.
2. **Stop-tar-start.** Nothing serves user traffic from OpenBao at 03:00, so the downtime
   itself is free — but a restarted OpenBao comes back **sealed**. Consistency would then
   depend on `vault.sh auto-unseal` firing correctly every single night, and its failure mode
   is a sealed vault that nobody notices until the next deploy. **That trades a rare risk for
   a routine one**, which is precisely the fragile machinery this exercise is supposed to
   avoid.

And the tar matters less than it looks: disaster-recovery steps 4–8 **re-initialise and
re-seed the vault from SOPS**, so `openbao-data.tar.gz` is a convenience, not the recovery
path. 180 KB, rarely written. **Accept the crash-consistency.**

### `prometheus-data` — the clearest "do not fix"

Prometheus runs with `--web.enable-lifecycle` and **not** `--web.enable-admin-api`, so the
TSDB snapshot endpoint is unavailable today. Enabling it would work — and would also switch
on the admin API's **series-deletion** endpoints, adding a destructive surface to a service
that currently has none, in exchange for protecting metrics.

Retention is `7d` / `20 GB`. In a disaster you are restoring an estate, and the value of the
seven days of scrape data that preceded it is approximately zero. The 664.5 MB nightly tar is
already the largest artifact in the backup set by a factor of six.

**Do not add the snapshot API.** The open question worth asking instead is whether
`prometheus-data` should be in the nightly set at all — it is 664.5 MB a night, retained seven
days, protecting data that is itself retained seven days.

The same reasoning applies to `loki-data` (59.3 MB) and `tempo-data` (39.9 MB), which are not
backed up today: **leave them out.**

### `prod_traefik-certs` — right cost, wrong blast radius

Stopping Traefik makes the tar consistent and takes `hill90.com`, `auth.hill90.com`, `api`,
`ai` and every Tailscale-only route down with it. If the tar then fails and a cleanup `trap`
does not fire, the edge stays down until somebody notices — at 03:00, that is hours.

Certificates re-issue from ACME on a fresh host, so the tar's real job is avoiding Let's
Encrypt **rate limits** during a rebuild, not preserving irreplaceable data. Keep taking it;
do not stop Traefik for it. See
[`certificates.md`](../architecture/certificates.md), and note `acme-dns.json` holds all four
DNS-01 certificates in one file.

### `prod_portainer-data` — free, and still not worth it

The one service where a brief stop costs nothing at all: Portainer is a Tailscale-only UI and
nothing depends on it. If you want the stop-tar-start pattern proven somewhere harmless, this
is where. But it protects 1 MB of UI state that a redeploy recreates, so the honest verdict is
that there is nothing here to protect either.

### `prod_minio-data` — the one to watch, with a trigger rather than a change

Object data is the **only** state in the backed-up set that is not reconstructible from git
plus SOPS plus a login. It is 112 KB today, which is why nothing needs doing now.

`backup_minio`'s existing comment rejects `mc mirror` because it would need working
credentials and somewhere to mirror to. That reasoning still holds at this size. It stops
holding when the store holds real objects.

**Trigger: when `prod_minio-data` exceeds roughly 100 MB, or when the tenant stores anything
a user would miss, revisit this row specifically.** At that point `mc mirror` — which is
per-object consistent and officially supported — becomes worth its credential handling, and
the xl.meta sidecar problem (object data and its metadata must agree) becomes a real
corruption mode rather than a theoretical one.

## What was actually changed

**Nothing mechanical.** No backup path was modified. The evidence said the one candidate
that looked clearly worth implementing was not, and implementing it anyway to have shipped
something would have added a dependency to protect a row that regenerates itself.

What did change is a claim this investigation proved wrong — see
[`disaster-recovery.md`](../runbooks/disaster-recovery.md).

## How the Grafana rebuild was verified

Non-destructive, on the VPS. A `grafana/grafana:11.6.0` container named
`gf-throwaway-verify`, on a **new empty volume**, with `--network none` and this
repository's provisioning directory bind-mounted **read-only**. It carried no Traefik
labels and joined no network, so it could not be published — invariant 3 says any container
on the socket with `traefik.enable=true` and a `Host` rule is live on the internet the
moment it starts.

Its database was read with Python's stdlib `sqlite3` over a `mode=ro` URI. The live volume
was likewise only ever opened read-only. Container and volume were removed afterwards and
both confirmed absent; the platform held **21 containers, 0 unhealthy** before and after —
14 platform (13 by name plus `minio`) and the tenant's 7.
