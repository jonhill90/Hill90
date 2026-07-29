# The Same Checkout Hazard on the Tenant Side

**Status:** assessment — nothing implemented here, and nothing to implement in
this repository
**Recorded:** 2026-07-29
**Scope:** an analysis of `hill90-app`'s deploy path, written from this side.
The guard, if it is built, belongs in that repository and is not this repo's to
write.
**Companion to:**
[deployment.md § Hand-edits on `/opt/hill90/app` are doomed by construction](../runbooks/deployment.md#hand-edits-on-opthill90app-are-doomed-by-construction)

## Bottom line

**The tenant has the same "lost edits" hazard and does *not* have the "live
config change" hazard.** That is a real difference, and it means the tenant guard
is the simpler of the two.

`scripts/preflight-checkout.sh` in this repository protects `/opt/hill90/app`
after an uncommitted change to `platform/edge/dynamic/middlewares.yml` was
destroyed on 2026-07-29. `hill90-app` has an equivalent deploy path and no
equivalent guard.

## The hazard is genuinely the same

`hill90-app`'s `.github/workflows/reusable-deploy-service.yml:296-299` runs, on
the VPS:

```
cd ${VPS_APP_PATH} && \
  git fetch origin && \
  ... && \
  git reset --hard origin/main && \
```

`VPS_APP_PATH` defaults to `/opt/hill90-app` (`:95`). So any uncommitted change
in that checkout is destroyed by the next deploy, unrecoverably, for exactly the
reason it was here: unstaged changes are never written to git's object database,
so there is no blob, no stash and no reflog entry.

## The negative result: nothing there is live-watched

This is the part worth stating plainly, because it makes the tenant's risk
smaller than this repository's.

**The tenant has no Traefik configuration directory at all.** It consumes
Hill90's Traefik and expresses all of its routing as container labels, which live
in the compose files and take effect only when `docker compose up` runs. There is
no file provider on the tenant side, so there is nothing equivalent to
`platform/edge/dynamic` and nothing with `watch: true`.

Its five repo-relative bind mounts, checked against `deploy/compose/prod/*.yml`
at `hill90-app` `6ae46d4`, are all read at container start:

| Path | Consumed by | When it takes effect |
|---|---|---|
| `platform/ai/litellm_config.yaml` | LiteLLM, `command: ["--config", "/app/config.yaml", ...]` | process start |
| `platform/auth/keycloak/hill90-realm.json` | Keycloak, `command: start --import-realm` | container start |
| `platform/auth/keycloak/themes/hill90` | Keycloak themes | container start — theme caching is ON |
| `platform/data/postgres/init.sh` | Postgres entrypoint | first initialisation only |
| `platform/vault/secrets-schema.yaml` | `api`, read at startup | process start |

**So the tenant's exposure is "an edit is silently lost and silently reverted",
not "an edit is a live production change".** Editing a file in that checkout does
not alter a running container until something restarts it.

### One caveat, and it closed tonight

The theme mount was briefly the closest thing to a live path. Until `hill90-app`
#20, `app-keycloak` ran with `--spi-theme-cache-themes=false` and
`--spi-theme-static-max-age=-1`, which are Keycloak's documented theme-*authoring*
settings and would have made theme files re-read rather than cached.

Two reasons not to overstate it: the flags were removed on 2026-07-29, and they
were spelled with a single hyphen where Keycloak 26.4 documents a double, so
whether they were ever in effect is unproven. The commit that removed them says
so itself. Either way the current state is caching ON, and no tenant path
reloads without a restart.

## A different hazard the tenant has and this repository does not

`docker-compose.api.yml:94` bind-mounts
`${AGENTBOX_CONFIG_HOST_PATH:-/opt/hill90/agentbox-configs}` and `:129` passes
the same path to `api`, which applies it to every agent container it creates.

That path is **outside the checkout**, so `git reset --hard` cannot touch it —
and it is **not version-controlled at all**. The failure mode is the mirror image
of the one this document is about: edits there survive every deploy and drift
permanently, with no record of what they are or when they changed. A checkout
preflight would not see it, and no guard proposed here would help.

Worth naming separately rather than folding into the same finding.

## What the guard would need to look like

Essentially this repository's `scripts/preflight-checkout.sh`, with one tier
removed and one list swapped:

- **Drop the `LIVE (WATCHED)` tier.** There is nothing to put in it, and a tier
  that never fires trains people to ignore the output.
- **Keep the `BIND-MOUNTED` tier**, populated with the five paths above. An
  uncommitted change to `hill90-realm.json` still matters more than one to a
  README — it is realm configuration that will silently revert at the next
  deploy, and the realm currently ships with no users, so its content is already
  load-bearing.
- **Keep the refusal-by-default and the full-diff print.** The diff is the only
  record that survives, which is the whole point, and that reasoning does not
  depend on anything being watched.
- **Keep the drift report.** This repository's checkout sat 12 commits behind
  `main` for three days with no signal; nothing about that failure is specific to
  which repository it happens in.
- **Wire it into the one reset site**, `reusable-deploy-service.yml`, rather than
  the four this repository has.

There is also a bootstrap caveat, learned here: the preflight runs *from* the
checkout it validates, so it will not exist on the box until one deploy after it
merges. With `&&` chaining, that first attempt halts rather than proceeding
unguarded — the safe direction, but it needs one manual `git pull` on the box.

## Why this is not implemented here

`hill90-app` is a separate repository with its own owner, and the guard belongs
next to the deploy path it protects. This document exists so the analysis is not
lost and so nobody has to re-derive the bind-mount inventory.

*Evidence for every claim above was read from `hill90-app` at `6ae46d4` on
2026-07-29. Nothing in that repository was modified.*
