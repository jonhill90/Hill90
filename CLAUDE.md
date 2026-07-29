# Hill90 — agent orientation

*(`AGENTS.md` and `CLAUDE.md` are the same file — one is a symlink, so there is
no second copy to drift.)*

Read this first. It is deliberately short; follow the links only when you need
them.

**What this is:** the homelab infrastructure for a single VPS — Traefik at the
edge, Keycloak for identity, Postgres, OpenBao, the LGTM observability stack,
Tailscale for private access, and Ansible plus GitHub Actions to rebuild it from
nothing. It is a **platform**: it hosts tenants but is not the application.
[hill90-app](https://github.com/jonhill90/hill90-app) is its first tenant.

## Where to look

- [`docs/runbooks/`](docs/runbooks/) — the operational procedures. Start with
  [`deployment.md`](docs/runbooks/deployment.md); [`vps-rebuild.md`](docs/runbooks/vps-rebuild.md)
  and [`disaster-recovery.md`](docs/runbooks/disaster-recovery.md) are the ones
  you hope not to need.
- [`docs/reference/`](docs/reference/) — the flag-level detail behind those
  procedures.
- [`docs/architecture/`](docs/architecture/) — how the pieces fit, plus
  [`certificates.md`](docs/architecture/certificates.md), which is the recovery
  path if ACME goes wrong.
- [`docs/decisions/`](docs/decisions/) — why things are the way they are.
  [`app-tenancy-on-the-vps.md`](docs/decisions/app-tenancy-on-the-vps.md) defines
  what this platform offers a tenant;
  [`tenant-checkout-hazard.md`](docs/decisions/tenant-checkout-hazard.md) records
  why the tenant needs its own checkout guard and why its risk is the smaller one.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — conventions and the deploy rules.
- Published pages: [docs.hill90.com](https://docs.hill90.com).

## Layout

```
deploy/compose/prod/    the platform stacks — infra, db, auth, vault, observability
platform/edge/          Traefik static template + dynamic middlewares
platform/auth/          Keycloak realm and theme
platform/observability/ Prometheus, Loki, Tempo, Grafana, exporters
infra/secrets/          SOPS-encrypted stores; age private keys are gitignored
scripts/                deploy.sh, backup.sh, _common.sh, checks/
ansible/                VPS bootstrap
docs/                   runbooks, reference, architecture, decisions
```

## Invariants — do not break these without an explicit decision

1. **Merging can deploy to production.** `.github/workflows/deploy.yml` triggers
   on push to `main` under `platform/auth/keycloak/**`,
   `platform/data/postgres/**`, `platform/observability/**` and four
   `deploy/compose/prod/*.yml` files. Check whether a PR touches a filtered path
   *before* merging it. `docs/**` is not filtered.
2. **`--remove-orphans` is banned globally**, in every script and workflow, and
   CI enforces it. It will delete containers belonging to another stack that
   shares a Compose project name.
3. **Production Traefik sets no provider `constraints`.** Every container on the
   socket with `traefik.enable=true` and a `Host` rule is live on the public
   internet the moment it starts. There is no staging state. Bring services up
   one at a time.
4. **`ACME_CA_SERVER` has no default.** `scripts/render-traefik-config.sh`
   refuses to render without it, and `ACME_REQUIRE_PRODUCTION=1` guards the
   opposite mistake. Switching CAs means Traefik will not reissue certificates it
   considers valid, so returning to production requires clearing the ACME
   stores — and `acme-dns.json` holds all four DNS-01 certificates in one file.
   Read [`docs/architecture/certificates.md`](docs/architecture/certificates.md)
   first.
5. **This repo owns the shared networks.** `docker-compose.infra.yml` and
   `scripts/deploy.sh` create `hill90_edge`, `hill90_internal` and
   `hill90_agent_internal`. Tenants consume them as `external: true` and must
   never create them. Renaming or removing one breaks every tenant silently.
6. **Readiness checks run a real query, not a liveness probe.** `pg_isready`
   exits 0 on a Postgres whose credentials are entirely broken; the db check runs
   `psql -tAc "SELECT 1"` as the real user for exactly that reason. Do not
   "simplify" it back.
7. **Secrets come from SOPS or OpenBao, never from a file in the tree.** Age
   private keys are gitignored; only `.pub` files are committed.

## Ground rules for changing this repo

- **Verify against the host, then date the claim.** Anything perishable —
  container counts, health, what a tenant is running — carries a
  `Verified <UTC timestamp>`. A dated claim that has aged is honest; an undated
  one is just wrong later.
- **Do not document what you have not run.** A compose file that parses is not a
  service that starts.
- A tenant's problems are not automatically this repo's problems. The contract
  this platform offers is narrow and written down in
  [`docs/decisions/app-tenancy-on-the-vps.md`](docs/decisions/app-tenancy-on-the-vps.md);
  widening it is a decision, not a fix.

## Open decisions — do not write these as settled

**One Keycloak is the decision; two are running.** Today the platform runs
`keycloak` (realms `master`, `platform`) and the tenant runs `app-keycloak`
(realms `master`, `hill90`) — verified 2026-07-29 05:55 UTC. **Decided:** there
will be one Keycloak, and the app will stop shipping its own. **Not decided:**
whether the app's clients land in a new `hill90` realm on the platform Keycloak
or in the existing `platform` realm — one Keycloak does not mean one realm.
**Not started:** no migration has happened, and the platform Keycloak has no
`hill90` realm to consolidate into. Export before delete, never the reverse.

One technical input to the realm question, recorded neutrally because it is
Jon's call and not a recommendation: the tenant hardcodes a fallback issuer of
`https://auth.hill90.com/realms/hill90` in two places
(`services/api/src/app.ts:105`, `services/mcp/app/main.py:17`). That realm
returns 404 on this platform's Keycloak today, so a blank `KEYCLOAK_ISSUER`
currently fails loudly. **If the consolidated realm is named `hill90`, that
fallback silently becomes correct**, and from then on a blank issuer is
indistinguishable from working configuration. Naming the realm something else,
or removing the fallbacks, would keep the failure loud. This is a factor, not an
argument for either option.

**Postgres is still two instances** — this platform's `postgres` and the
tenant's `app-postgres`, on separate volumes. **No decision has been recorded.**
Consolidating data is not obviously the same move as consolidating identity:
this platform's health check asserts platform-only databases, which is a
designed boundary.

## Fast facts

```bash
bash scripts/deploy.sh <infra|db|auth|vault|observability> prod
bash scripts/deploy.sh verify <service> prod
gh workflow run deploy.yml -f service=all
```

- Platform baseline is **13 containers, 0 unhealthy**. A tenant's containers sit
  alongside them and are not part of that count. **Verify the baseline after any
  tenant action — a degraded baseline is the stop-everything signal.** The
  tenancy contract has been tested in both directions: on 2026-07-29 the tenant
  was torn down to a single container and redeployed, and this platform held at
  exactly 13 with all shared networks intact throughout.
- Public: `hill90.com` (the tenant's UI), `auth.hill90.com` (this platform's
  Keycloak, realm `platform`). Tailscale-only: `traefik`, `portainer`,
  `grafana`, `vault`.
- `app-auth.hill90.com` is the **tenant's** Keycloak, not this one.
- The deploy user on the VPS is `deploy`; the checkout is `/opt/hill90/app`.
  `/opt/hill90-app` is the tenant's, despite the similar name.
