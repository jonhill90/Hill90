# Overnight summary — 2026-07-26

What changed while you slept. Hill90 `main` is `7032b80`, 27 PRs merged since the
strip began. Nothing is broken and nothing is waiting on you to unblock work.

---

## Two things need your decision

### 1. Whether to reinitialize the vault

OpenBao is running, unsealed, healthy, auto-unsealing across reboots — and
**permanently unconfigurable**. Root was revoked immediately after init, before
any policies or KV data existed, and OpenBao ≥ 2.5.3 disables root
regeneration — verified on a throwaway 2.6.1 instance and on the live vault.
There is no way back to root.

Nothing is broken by it: the vault holds nothing, and every deploy falls back to
SOPS, which has been the operative store since June.

[vault-vs-sops.md](vault-vs-sops.md) recommends documenting SOPS as the active
path and leaving the vault dormant until there is a concrete consumer.

**Saying yes is one dispatch, not a sequence you have to run** (#521):

```bash
gh workflow run vault-reinitialize.yml \
  -f confirm=REINITIALIZE -f i_have_read_the_decision_doc=true -f switch_to_raft=true
```

That runs the whole sequence — back up, wipe, redeploy, init, unseal, configure,
seed, sync token, auto-unseal proof — and opens a PR with the new secrets. It
refuses unless the confirmation is exactly `REINITIALIZE`, refuses if the vault
holds data, and refuses if the backup failed. Root is **not** revoked; that
one-way door stays a separate command, printed at the end.

The raft switch rides along, since the volume is being wiped anyway (#517). The
`file` backend goes in OpenBao v2.7.0; the image is pinned to `2.6.1` (#518) so
that lands deliberately, but the vault cannot move past 2.6.x until it changes.

It costs a volume deletion on the live host and merging the PR the run opens.

### 2. Whether to delete 159 remote branches

Hill90 has 168 branches besides `main`. The audit (#519) puts every one in a
category, and **159 have nothing at risk** — either every file version already
exists in a preserved history, or the only unique content is a superseded draft
of a file that later merged.

```bash
bash scripts/cleanup-branches.sh delete-safe --yes    # 159 branches, one push
```

Dry-runs without `--yes`. It never touches the other nine.

**The nine that did hold unique work are already tagged** under
`archive/unmerged/`, verified present on the remote, so they are safe permanently
whatever you decide. Between them they held ~1,059 lines existing nowhere else —
the largest a 428-line tmux supervisor skill document, the rest shelved-app UI.
Details in [the branch audit](2026-07-26-branch-audit.md).

---

## The three repositories

### Hill90 — infrastructure only, deployed and healthy

The strip is finished, steps 1–5 (#494–#498). Eleven containers on the VPS: edge
(traefik, dns-manager, portainer), observability (prometheus, grafana, loki,
tempo, promtail, node-exporter, cadvisor) and openbao. `services/dns-manager`
stayed — it is the DNS-01 ACME webhook Traefik depends on, not app code.

It runs on your Mac now, from the same compose files production uses:

```bash
bash scripts/local.sh up
```

- http://grafana.localtest.me:8080/ — admin / admin
- http://prometheus.localtest.me:8080/
- http://traefik.localtest.me:8080/dashboard/
- http://portainer.localtest.me:8080/

Every variable defaults to the production value, so with no environment set the
compose files resolve byte-for-byte to what the VPS gets — local development is
what happens when you *add* variables. `check_env_surface.py` fails CI if the two
drift. Guide: [local-development.md](../runbooks/local-development.md).

### hill90-app — the extracted application, CI green

The eight application services with full history. **CI passes on `main` across
all six jobs — 1,953 tests, zero failures**, on its first ever run. For a
codebase shelved for a year that is a better result than expected. Its local
stack brings up nine healthy containers with a working login.

There is still no deployment path; that is called out honestly in its
`RESURRECTION.md`.

### docker-infra-template — the generic boilerplate

Scaffolded, with a tier-2 DNS-01 httpreq sidecar and Hostinger driver, the local
functional verification matrix, the OpenBao and local-dev lessons back-ported
from Hill90, and first-run docs written to assume no prior context. CI green.

---

## What is verified, and how

Claims here were checked rather than recalled.

**The vault pin deployed and recovered unattended.** `deploy-vault` ran on merge
and openbao came back on `2.6.1`, healthy and unsealed, without intervention — so
auto-unseal surviving an unattended recreate is now proven in production rather
than in a test. Pinned to what was genuinely running: tags `2`, `2.6`, `2.6.1`
and `latest` all resolved to the same digest, so the pin was a no-op.

**The local runbook is verified cold** (#514) — fresh clone into an empty
directory, every stack image deleted, no volumes, no networks, no `.env.local`,
empty build cache. Ten containers in 83 seconds, all four surfaces serving their
own UI, 7/7 Prometheus targets up, teardown leaving volumes intact.

**The branch audit used blob identity, not merge-base.** Ancestry would have
called 162 branches unmerged, which is an artifact of squash merging; comparing
content to `main` flags 160, because the strip deleted `services/`. Indexing all
3,635 blob SHAs across the three histories survives rewritten SHAs, retitled
squashes and filtered history. Two of my own checks had bugs producing false
alarms before being caught — both recorded in the audit.

**DNS drift is closed.** `dns sync` posted `overwrite: true` with 7 record groups
against a 33-group zone, which would have destroyed the `remote` A record — the
only SSH path to the VPS — plus every mail record (#504). Fixed and
regression-tested. `vps` repointed, `openclaw` and its orphaned ACME challenge
deleted; the zone is 31 groups, every hostname verified on two resolvers.

---

## Housekeeping already done

- `vault.sh init` and `setup-sync-token` no longer print the unseal key or root token — they were echoing secrets into what would have been Actions logs. #499, #510
- A sanctioned `vault-init.yml` workflow replaced hand-run SSH for initialization. #502
- `OPENBAO_UNSEAL_KEY` is stored in SOPS without passing through the process table or shell history. #505
- The weekly `vault-sync-to-sops` schedule is **disabled**. It had failed every Monday since June and cannot succeed without root; an alert that always fires only trains you to ignore it. `workflow_dispatch` still works and the four conditions for re-enabling are recorded at the schedule block. Reversible in one line. #511
- `docs/reference/secrets.md` claimed the age private key is tracked in the repo. `.gitignore` has always excluded it. Corrected. #504

## Housekeeping you may want to do

Three copies of the infra stack are running on your Mac — `hill90dev` is yours,
`hill90vfy` and `verify94072` belong to lanes that were mid-verification. They
tear down on their own; noted only so the container count is not a surprise.
