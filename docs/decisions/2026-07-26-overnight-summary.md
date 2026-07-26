# Overnight summary — 2026-07-26

What changed in Hill90 while you were asleep. Twenty PRs merged; `main` is
`ce2363b`. Nothing is broken and nothing is waiting on you to unblock work.

---

## Two things need your decision

### 1. Whether to reinitialize the vault

OpenBao is running, unsealed, healthy, auto-unsealing across reboots — and
**permanently unconfigurable**. The root token was revoked immediately after
init, before any policies, AppRoles or KV data existed. On OpenBao ≥ 2.5.3 the
unauthenticated root-generation endpoints are disabled by default, so
`bao operator generate-root` returns 403; that was verified against 2.6.1 on a
throwaway instance and again on the live vault. There is no supported way back
to root.

So the vault holds nothing, and every deploy falls back to SOPS — visibly:

```
WARNING: OpenBao available but login failed for vault, falling back to SOPS
```

Nothing is broken by this. SOPS has been the operative secrets store since June
and still is.

The choice is in [vault-vs-sops.md](vault-vs-sops.md), which recommends
documenting SOPS as the active path and leaving the vault code dormant until
there is a concrete consumer. If you'd rather reinitialize, the ordered runbook
is in the same doc — it costs a volume deletion on the live host and a second PR
for the new unseal key, because a fresh init invalidates the one merged in #505.
The ordering matters: revoking root early is exactly what produced the current
inert vault.

The counter-argument the doc makes explicitly: this is a homelab, and running
OpenBao to learn OpenBao is a perfectly good reason — worth stating deliberately
rather than letting the docs assert it for you.

### 2. The `file` storage backend is removed in OpenBao v2.7.0

This applies whichever way you decide above.

```
[WARN] storage.file: the file physical backend is deprecated;
use bao operator migrate to move to a supported storage backend by v2.7.0
```

`platform/vault/config.hcl` uses `storage "file"`. The compose file used to pin
`ghcr.io/openbao/openbao:2`, a floating major tag, which would have broken on a
routine image pull rather than a deliberate upgrade — **it is now pinned to
`2.6.1`** (#518), so the surprise is gone. The vault still cannot be upgraded
past 2.6.x until the storage backend moves.

The migration path is now researched and written up in
[vault-vs-sops.md](vault-vs-sops.md#decision-needed-replacing-the-file-storage-backend-jon-48):
raft is the answer, the config change is three additive lines, and the unseal
and auto-unseal flow is unaffected. The useful part: **if you reinitialize the
vault anyway, switching storage in the same pass costs essentially nothing** —
the volume is already being wiped.

---

## The app strip is finished

Steps 1–5 all merged. Hill90 is now what the June decision said it should be:
infrastructure only, three stacks, ten containers.

| Step | PR |
|---|---|
| Remove the eight application services | #494 |
| Remove Keycloak, Postgres, MinIO | #495 |
| Rewrite the documentation | #496 |
| Drop observability config for removed services | #497 |
| Final verification and residual fixes | #498 |

The application is preserved twice: the `archive/app-stack-final` tag, and the
`hill90-app` repository with full history. `services/dns-manager` stayed — it is
live infrastructure, the DNS-01 ACME webhook Traefik depends on, not app code.

Confirmed on the live host after deploy: ten containers, observability
redeployed healthy, edge serving. Detail in
[infra-app-separation.md](infra-app-separation.md).

## Hill90 now runs on your Mac

```bash
bash scripts/local.sh up
```

Ten containers in about 80 seconds. It is running right now — open these:

- http://grafana.localtest.me:8080/ — admin / admin
- http://prometheus.localtest.me:8080/
- http://traefik.localtest.me:8080/dashboard/
- http://portainer.localtest.me:8080/

**The same compose files serve local and prod.** Every variable defaults to the
production value, so with no environment set the files resolve byte-for-byte to
what the VPS gets — local development is what happens when you *add* variables,
and it cannot silently change production. `check_env_surface.py` fails CI if the
two drift, and `deploy.sh teardown` makes rebuild routine without ever touching
volumes.

PRs #500, #508, #512, #513. Full guide:
[local-development.md](../runbooks/local-development.md) — which carries a
verified-cold statement: proven from a fresh clone on a machine with no images,
no volumes and no config, not from the machine that built it (#514).

## DNS and docs drift cleaned up

**`dns sync` would have wiped the zone.** It posted `overwrite: true` with 7
record groups against a 33-group zone, which replaces the whole zone. That would
have destroyed the `remote` A record — the only SSH path to the VPS — plus every
mail record, `www`, `docs` and a minecraft SRV. The flag is gone, verified
empirically rather than from the API docs. `remote` was also missing from both
repo record files despite being load-bearing; both now agree, with tests. #504

Also: `vps.hill90.com` repointed from a dead address, `openclaw` and its orphaned
ACME challenge deleted (zone 33 → 31, each verified after writing), and
`secrets.md` corrected — it claimed the age private key is tracked in the repo,
which `.gitignore` has always excluded.

## Housekeeping

- `vault.sh init` and `setup-sync-token` no longer print the unseal key or root token — they were echoing secrets that would have landed in Actions logs. #499, #510
- A sanctioned `vault-init.yml` workflow replaced hand-run SSH for initialization. #502
- `OPENBAO_UNSEAL_KEY` is stored in SOPS without passing through the process table or shell history. #505
- The weekly `vault-sync-to-sops` schedule is **disabled**. It had failed every Monday since June and cannot succeed without root; an alert that always fires just trains you to ignore it. `workflow_dispatch` still works, and the four conditions for re-enabling are recorded at the schedule block. Reversible in one line. #511

## Housekeeping you may want to do

There are 31 containers on this Mac across three copies of the stack —
`hill90dev` (yours, keep it), plus `hill90vfy` and `verify94072` from other
lanes still mid-verification. Those two will be torn down by the lanes that own
them; they are only noted here so the container count is not a surprise.
