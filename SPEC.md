# Hill90 — App/Infra Separation Specification

**Status:** proposed
**Date:** 2026-07-26
**Companion:** [PRD.md](PRD.md)
**Decision record:** [docs/decisions/infra-app-separation.md](docs/decisions/infra-app-separation.md)

This is the authoritative inventory of what stays in Hill90 and what leaves,
with the blast radius, ordering, verification and rollback for each removal.

Every claim below was checked against the tree at `1b9394c`, the branch point of
`refactor/strip-app`. `main` has since advanced to `f03f12d` (PR #493). That
commit changes exactly one file — `infra/secrets/prod.enc.env`, 7 insertions and
7 deletions, correcting the Tailscale IPs — so no line citation in this document
is affected. Step 0 rebases onto it regardless, and citations should be
re-asserted after that rebase as a matter of routine. Line citations are
`path:line`.

---

## 0. Ground truth

### Live state, verified 2026-07-26

Read-only SSH to `deploy@remote.hill90.com` (`srv1264324.hstgr.cloud`, up 5
days, public IP `76.13.26.69`, tailnet peer `hill90-vps` at `100.88.29.112`).

Ten containers running, and only these:

```
traefik  dns-manager  portainer
prometheus  grafana  loki  tempo  promtail  cadvisor  node-exporter
```

Two consequences drive this entire specification:

1. **The infra and observability stacks are live.** Every change must keep
   `deploy.sh infra prod` and `deploy.sh observability prod` working.
2. **Nothing else is running.** No `postgres`, `keycloak`, `minio` or `openbao`
   container exists. Removing those stacks from the repository cannot break
   anything currently deployed — the question is purely whether the repo should
   retain the capability.

### Corrections to the starting assumptions

The rough inventory this lane started from was wrong in four places. All four
were verified directly.

| Assumption | Reality |
|---|---|
| `services/` is entirely application | **`services/dns-manager` is live infrastructure.** A Flask webhook implementing Traefik's `httpreq` DNS-01 provider against the Hostinger API (`services/dns-manager/app.py:1-5`), built by `deploy/compose/prod/docker-compose.infra.yml:27`, and one of the ten running containers. `services/` must not be deleted wholesale. |
| `services/` is api, ai, ui, mcp, knowledge, chat, agentbox | There is no `chat` service — chat lives inside `services/agentbox/app/chat.py`. There are three the decision record never named: `cli`, `discord-bot`, `dns-manager`. |
| The app is coherent | Three parts are **already orphaned**: `services/cli` has zero references anywhere outside itself; `deploy/compose/prod/docker-compose.discord-bot.yml` has no deploy case, Makefile target or CI job; `deploy/compose/dev/docker-compose.yml:55` builds `services/auth`, which does not exist. |
| The VPS may be unreachable | A wrong-tailnet artifact in this session. The host is healthy and SSH works. |

### Repository weight

Tracked files by top-level directory: `services` 595, `docs` 51, `platform` 43,
`tests` 24, `infra` 23, `.github` 20, `scripts` 18, `deploy` 16, `packages` 4.

Within `services/`: `ui` 225, `api` 187, `knowledge` 88, `agentbox` 37, `ai` 36,
`mcp` 11, `discord-bot` 4, `cli` 4, `dns-manager` 3.

---

## 1. The inventory

Verdicts: **KEEP** stays in Hill90 · **REMOVE** deleted · **MOVE** transferred to
`hill90-app` · **EDIT** survives with app content stripped.

### 1.1 `services/`

| Component | Verdict | Reasoning | Evidence |
|---|---|---|---|
| `services/dns-manager` | **KEEP** | Traefik DNS-01 ACME webhook. Running in prod. Without it, certificate issuance for Tailscale-only hosts breaks. | `docker-compose.infra.yml:27`; `platform/edge/traefik.yml:75` |
| `services/api` | REMOVE | TypeScript control plane for the shelved agent platform. | `docker-compose.api.yml:77` |
| `services/ai` | REMOVE | Model-router in front of LiteLLM. Application by explicit decision. | `docker-compose.ai.yml:60` |
| `services/ui` | REMOVE | Next.js frontend, NextAuth + Keycloak. | `docker-compose.ui.yml:16` |
| `services/mcp` | REMOVE | MCP gateway, JWT-verified via Keycloak. | `docker-compose.mcp.yml:16` |
| `services/knowledge` | REMOVE | Agent Knowledge Manager plus a Go CLI under `knowledge/cli/`. | `docker-compose.knowledge.yml:27` |
| `services/agentbox` | REMOVE | Sandboxed agent runtime. Three Dockerfiles. | `docker-compose.agentbox-images.yml:10,16,24` |
| `services/cli` | REMOVE | `hill90-cli` terminal client. Already orphaned — no Dockerfile, no references. | zero refs outside itself |
| `services/discord-bot` | REMOVE | Bridges Discord to agent chat; polls `http://api:3000`. Compose file already orphaned. | `docker-compose.discord-bot.yml:8` |

### 1.2 `deploy/compose/`

| Component | Verdict | Reasoning | Evidence |
|---|---|---|---|
| `prod/docker-compose.infra.yml` | **KEEP** | Live. Sole owner of `hill90_edge`, `hill90_internal`, `hill90_agent_internal`. Runs traefik, dns-manager, portainer. | `:7-17,27,45,81` |
| `prod/docker-compose.observability.yml` | **KEEP** (EDIT) | Live. Seven containers. Edits confined to Prometheus config, not this file. | `:27-157` |
| `prod/docker-compose.vault.yml` | **KEEP** | OpenBao. Not currently deployed but retained by decision. | `:19` |
| `prod/docker-compose.db.yml` | REMOVE | Postgres + postgres-exporter. Not running; last tenant was Keycloak. | `:16,35` |
| `prod/docker-compose.auth.yml` | REMOVE | Keycloak. Not running; consumers were api/mcp/ui. | `:15` |
| `prod/docker-compose.minio.yml` | REMOVE | Not running; only programmatic consumer was the API. | `:16` |
| `prod/docker-compose.api.yml` | REMOVE | Also creates `hill90_agent_sandbox` and `hill90_docker_proxy`. | `:16-23,27,77` |
| `prod/docker-compose.ai.yml` | REMOVE | LiteLLM + model-router. | `:27,60` |
| `prod/docker-compose.{ui,mcp,knowledge}.yml` | REMOVE | App services. | — |
| `prod/docker-compose.agentbox-images.yml` | REMOVE | Build-only, no stack, no networks. Referenced only by an app doc. | `:10,16,24` |
| `prod/docker-compose.discord-bot.yml` | REMOVE | Already orphaned. | `:4` |
| `prod/.env.example` | EDIT | Prune app variables. | — |
| `dev/` (whole tree) | REMOVE | Already broken: builds `services/auth`, which does not exist. Every other build context is an app service. | `dev/docker-compose.yml:18,38,55,79` |

### 1.3 `platform/`

| Component | Verdict | Reasoning | Evidence |
|---|---|---|---|
| `platform/edge/traefik.yml` | **KEEP** (EDIT) | Live Traefik config. Strip app hostnames from the comment at `:61`. | — |
| `platform/edge/dynamic/middlewares.yml` | **KEEP** (EDIT) | Generic middlewares. Remove `mcp-strip` (`:44-47`, used only by `docker-compose.mcp.yml:48`) and the app domains in the CORS origin list (`:62-65`). | — |
| `platform/observability/**` | **KEEP** (EDIT) | Live. See §2.3 for the exact Prometheus and Grafana edits. | — |
| `platform/vault/config.hcl` | **KEEP** | OpenBao server config. | — |
| `platform/vault/policies/policy-{infra,observability,admin,sync}.hcl` | **KEEP** | Infra AppRoles plus the root-ish admin and the sync-token policy. `cmd_policy_apply` globs `policy-*.hcl` (`vault.sh:461`), so the set is derived from what exists. | — |
| `platform/vault/policies/policy-{db,minio,auth}.hcl` | REMOVE | Go with their stacks. | — |
| `platform/vault/policies/policy-oidc-admin.hcl` | REMOVE | **Coupled to Keycloak** — the only principal that can hold it is a Keycloak-authenticated operator. Dead once auth goes. See §2.9. | `vault.sh:256,262` |
| `platform/vault/policies/policy-{api,ai,ui,mcp,knowledge}.hcl` | REMOVE | App AppRole policies. | — |
| `platform/vault/secrets-schema.yaml` | **KEEP** (EDIT) | Dual role: CI input **and** a runtime bind mount into the api container. The mount dies with the app; the CI role stays. Prune app entries. | `docker-compose.api.yml:95,98` |
| `platform/ai/litellm_config.yaml` | REMOVE | LiteLLM model routing. Whole directory goes. | `docker-compose.ai.yml:35` |
| `platform/auth/keycloak/**` | REMOVE | Realm, `setup-realm.sh`, themes. Goes with the auth stack. | `docker-compose.auth.yml:23-24` |
| `platform/data/postgres/init.sh` | REMOVE | Creates `keycloak`, `hill90_api`, `hill90_akm`, `hill90_litellm`. | `docker-compose.db.yml:24` |

### 1.4 `scripts/`

| Component | Verdict | Reasoning |
|---|---|---|
| `_common.sh` | **KEEP** (EDIT) | Prune app arms from `vault_paths_for_service()` (`:152-166`). Degrades gracefully either way — the default arm returns empty. |
| `deploy.sh` | **KEEP** (EDIT) | Major surgery. See §2.2. |
| `backup.sh` | **KEEP** (EDIT) | Targets are `db\|minio\|vault\|infra\|observability` (`:151,160-164,211-244`). Drop `db` and `minio`. No app targets exist. |
| `rollback.sh` | **KEEP** (EDIT) | `service_paths()` (`:47-55`) maps app services at `:47-50` and `:52` (`services/api/src/db/migrations/`). |
| `validate.sh` | **KEEP** (EDIT) | Compose validation is glob-driven (`:356`), self-adapting. Required-secrets list at `:262-267` hard-codes `JWT_SECRET` — must be pruned or `validate.sh secrets` fails. |
| `ops.sh` | **KEEP** (EDIT) | Health list hard-codes `api.hill90.com` and `ai.hill90.com` (`:33-34`); public domains at `:161`; MinIO checks throughout. |
| `secrets.sh` | **KEEP** | SOPS lifecycle. No app coupling. |
| `vault.sh` | **KEEP** (EDIT) | `VAULT_SERVICES` (`:16`) drives AppRole and policy creation; seeds app KV paths at `:314,321,325,335,381,389,401,421-447`. Also loses the entire OIDC path — see §2.9. |
| `hostinger.sh` | **KEEP** (EDIT) | VPS and DNS API. Prunes at `:356,386-395,431,456`. |
| `vps.sh` | **KEEP** | VPS lifecycle. |
| `provision-akm-db.sh` | REMOVE | Creates `hill90_akm`. App-only. |
| `provision-litellm-db.sh` | REMOVE | Creates `hill90_litellm`. App-only. |
| `checks/check_md_links.py` | **KEEP** | Hard CI gate. |
| `checks/check_secrets_schema.py` | **KEEP** | Globs prod compose files; self-adapting. |
| `checks/check_volume_names.py` | **KEEP** (EDIT) | `TARGET_FILES` (`:23-29`) lists db, infra, minio, observability, vault. Drop db and minio. |
| `checks/check_destructive_commands.sh` | **KEEP** | Infra gate. |
| `checks/check_docs_secrets.sh` | **KEEP** | Hard-codes `DOCS_DIR="docs/site"` (`:6`) but skips cleanly when absent (`:26-29`). Becomes a no-op after the move; keep or remove at implementation time. |
| `checks/check_legacy_agentbox.sh` | REMOVE | Anti-regression gate for legacy agentbox paths. Vestigial once agentbox is gone. |

### 1.5 `infra/`

| Component | Verdict | Notes |
|---|---|---|
| `infra/ansible/**` | **KEEP** (EDIT) | One app reference in the entire tree: `playbooks/01-system-prep.yml:62` creates `{{ app_directory }}/agentbox-configs`, the host bind mount for the api container (`docker-compose.api.yml:94`). Remove that one task. Everything grepping as "api" in `09-traefik.yml` is `api@internal` or Let's Encrypt. |
| `infra/dns/hill90.com.json` | **KEEP** (EDIT) | Eight A records. Remove `api` and `ai`; remove `auth` and `storage` with Keycloak and MinIO. Keep `@`, `vault`, `portainer`, `traefik`. |
| `infra/secrets/.sops.yaml`, `keys/` | **KEEP** | — |
| `infra/secrets/prod.enc.env` + `.example` | **KEEP** (EDIT) | Prune app keys. See §2.5. |
| `infra/systemd/hill90-vault-unseal.service` | **KEEP** | Depends on `scripts/vault.sh` staying at its path. See §5, note 1. |

### 1.6 `docs/`

**Keep as-is (infra):** `runbooks/{bootstrap,observability,secrets-schema-validation,secrets-workflow,vault-unseal}.md`; `reference/{secrets,tailscale}.md`; `decisions/infra-app-separation.md`.

**Keep with edits (mixed):** `architecture/{overview,secrets-model,security,certificates}.md`; `reference/{deployment,dns,github-actions,vps-operations}.md`; `runbooks/{deployment,disaster-recovery,troubleshooting,vps-rebuild}.md`.

**Remove (app):** `architecture/{agent-harness,agent-identity-model,agent-progression-system,mcp-gateway-evaluation,memory-model-boundaries,secrets-vault-ui-design,task-board,terminal-streaming-protocol,trust-boundaries,ui-components}.md`; `runbooks/{agent-file-ops-verification,api-auth-verification,keycloak-auth-ops}.md`; `development/local-setup.md`.

**Move to `hill90-app`:** `docs/site/` entire tree — 10 `.mdx` pages, `docs.json`, branding, and `openapi.yaml` (5,477 lines, a byte-copy of `services/api/src/openapi/openapi.yaml`).

Note: `docs/runbooks/keycloak-auth-ops.md` is classified app rather than infra
because Keycloak itself is being removed; its content is password-grant API
testing for the shelved services.

### 1.7 `.github/workflows/`

| Workflow | Verdict |
|---|---|
| `ci.yml` | **KEEP** (EDIT) — see §2.4 |
| `deploy.yml` | **KEEP** (EDIT) — see §2.4 |
| `reusable-deploy-service.yml` | **KEEP** — service-agnostic |
| `deploy-{infra,vault,observability}.yml` | **KEEP** |
| `config-vps.yml`, `recreate-vps.yml`, `tailscale.yml`, `vault-sync-to-sops.yml` | **KEEP** |
| `deploy-{db,minio,auth}.yml` | REMOVE — with their stacks |
| `deploy-{api,ai,ui,mcp,knowledge}.yml` | REMOVE |
| `smoke-auth.yml` | REMOVE — runs `tests/e2e/`, which goes entirely |
| `pull_request_template.md` | EDIT — `:8` "API/MCP (if applicable)" |

### 1.8 `tests/`

| Component | Verdict | Notes |
|---|---|---|
| `tests/e2e/` | REMOVE | All 12 Playwright specs. `auth-theme.spec.ts` is the only non-app one and it targets Keycloak, which is going. |
| `tests/checks/test_deploy_scope.py` | **KEEP** (EDIT) | Heavy surgery — see §2.6. |
| `tests/checks/test_secrets_schema.py` | **KEEP** | Mostly fixture-driven. `:157-167` asserts the real tree emits no `[WARN]`. |
| `tests/scripts/{ops,hostinger,vps,secrets,backup}.bats` | **KEEP** (EDIT) | Infra suites; edits limited to removed-stack references. |
| `tests/scripts/{deploy,validate,rollback,vault}.bats` | **KEEP** (EDIT) | Heavy surgery — see §2.6. |

### 1.9 Root and other

| Component | Verdict |
|---|---|
| `README.md` | EDIT — ~40% is app content. Full section map in §2.7. |
| `CONTRIBUTING.md` | EDIT — command map rows, two dead doc links, the OpenAPI guardrail. |
| `Makefile` | EDIT — see §2.7. |
| `policy.hujson` | **KEEP** — Tailscale ACLs. |
| `packages/common` | REMOVE — a stub with **zero consumers**. Four files, two of which are a version constant. Repo-wide grep finds only its own self-declarations. Deletable independently of this work. |

---

## 2. Blast radius

### 2.1 The inseparable cluster

`api`, `knowledge` and `agentbox` cannot be removed independently.
`scripts/deploy.sh:388-390`, inside the `api` branch, hard-fails:

```sh
if ! docker image inspect hill90/knowledge:latest >/dev/null 2>&1; then
    die "Cannot build agentbox: hill90/knowledge:latest not found..."
fi
docker build --no-cache -t hill90/agentbox:latest services/agentbox/
```

Removing `knowledge` first breaks `deploy.sh api`. Remove all three in one step.

Similarly, `docker-compose.api.yml:16-23` **creates** `hill90_agent_sandbox` and
`hill90_docker_proxy`, which `ai.yml:16` and `knowledge.yml:16` declare
`external: true`. Removing `api.yml` alone orphans those declarations. Note
`docker-compose.infra.yml` creates only `edge`, `internal` and `agent_internal`
— nothing recreates `agent_sandbox`.

### 2.2 `scripts/deploy.sh`

The dispatcher (`:653-665`) collapses to:

```sh
infra)                       cmd_infra "$@" ;;
vault|observability)         cmd_service "$cmd" "$@" ;;
verify)                      cmd_verify "$@" ;;
backup)                      bash "$SCRIPT_DIR/backup.sh" backup "$@" ;;
help|--help|-h)              usage ;;
```

Removals inside the file:

| Lines | What |
|---|---|
| `:49-51` | Dependency health map — `postgres`, `keycloak` arms |
| `:76-83`, `:87` | `cmd_verify` arms for db, auth, api, ai, mcp, ui, knowledge, agentbox |
| `:229-268` | The entire `agentbox` early-return branch |
| `:271-354` | `cmd_service` arms for db, auth, api, ai, mcp, minio, ui, knowledge |
| `:380-393` | api preflight: `agentbox-configs` mkdir/chown, agentbox image build |
| `:398-429` | knowledge/ai `akm-keys` volume seeding |
| `:440-451` | Pre-deploy dependency checks (auth→postgres, api\|mcp→postgres+keycloak, knowledge→postgres) |
| `:565-580` | Post-api agentbox container recycling |
| `:596-637` | `cmd_all` entirely — it loops `auth api ai mcp ui` |
| `:655` | Dispatcher arm |

Preserved unchanged: `cmd_infra` (`:115-224`), the `vault` arm (`:328-336`) and
its post-deploy auto-unseal (`:556-560`), the `observability` arm
(`:355-369`), and the network guard at `:432-438`.

### 2.3 Observability — the only edit to a running stack

This is the highest-risk change in the whole specification, because Prometheus
and Grafana are live. `docker-compose.observability.yml` itself needs no edit;
the coupling is entirely in mounted config.

| File | Change |
|---|---|
| `platform/observability/prometheus/prometheus.yml` | Remove the `keycloak` job (`:17-20`), `postgres-exporter` (`:30-32`) and `minio` (`:34-37`). Keep prometheus, traefik, node-exporter, cadvisor, grafana, loki, tempo. |
| `platform/observability/prometheus/alerts.yml` | Remove the whole `postgres` group (`:36-46`), whose only rule is `PostgresConnectionsHigh`. Keep `ServiceDown`, `HighMemoryUsage`, `DiskSpaceRunningLow`, `LokiIngestionErrors`, `TempoIngestionErrors`. |
| `platform/observability/grafana/provisioning/dashboards/` | Delete `keycloak.json`, `postgres.json`, `minio.json`. Keep `cadvisor`, `loki-logs`, `node-exporter`, `traefik`, and `dashboards.yml`. |

`postgres-exporter` is defined in `docker-compose.db.yml:35`, not in the
observability stack — it goes with the db stack.

Doing this in the correct order matters: dropping the scrape targets **before**
redeploying observability means Prometheus never looks for hosts that no longer
exist. Doing it after leaves `ServiceDown` firing on `up == 0`.

### 2.4 CI workflows

**`ci.yml`** — delete these steps:

| Lines | Step |
|---|---|
| `:28-29` | Check legacy agentbox paths removed |
| `:71-74` | Setup Node.js |
| `:76-78` | Run API tests (`services/api`) |
| `:80-82` | Validate OpenAPI spec |
| `:84-85` | Validate docs OpenAPI sync — `diff services/api/src/openapi/openapi.yaml docs/site/openapi.yaml` |
| `:90-92` | Run UI tests |
| `:94-96` | Verify UI production build |
| `:106-111` | Run MCP tests |
| `:113-118` | Run Agentbox tests |

`:87-88` (`check_docs_secrets.sh`) may stay — it self-skips when `docs/site/` is
absent. Python setup (`:98-101`) must stay: `tests/checks/` still needs it.

Everything else in `ci.yml` is glob-driven and self-adapts: markdown links
(`:20-21`), bats (`:31-32`), compose validation (`:34-39`), Traefik validate
(`:41-42`), shellcheck (`:47-48`), deploy safety invariants (`:50-58`), volume
names (`:60-61`), secrets schema (`:63-66`), destructive commands (`:68-69`),
pytest (`:103-104`).

**`deploy.yml`** — remove app trigger paths (`:7-10`, `:18-24`), the auth/db/minio
paths (`:11-12`, `:14-17`) with their stacks, the dispatch choices (`:31`), the
dorny filter blocks (`:73-89`), and the jobs `deploy-db` (`:95`), `deploy-minio`
(`:103`), `deploy-auth` (`:120`), `deploy-api` (`:129`), `build-agentbox`
(`:137`), `deploy-ai` (`:145`), `deploy-mcp` (`:153`), `deploy-ui` (`:161`),
`deploy-knowledge` (`:169`). What survives: `deploy-vault` (`:111`) and
`deploy-observability` (`:177`).

Note the dependency chain being dismantled: `deploy-api` needs `deploy-auth`
(`:130`), `deploy-mcp` needs `deploy-auth` (`:154`), `deploy-knowledge` needs
`deploy-db` (`:170`).

`deploy-infra.yml:117` checks TLS for `api.hill90.com` — warn-only (`:123-128`),
but should be pruned for tidiness.

### 2.5 Secrets

Two files move together, always in the same commit:
`platform/vault/secrets-schema.yaml` and `infra/secrets/prod.enc.env.example`
(plus the encrypted `prod.enc.env` itself).

**Remove:** `JWT_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` (schema `:46,50,54`);
`INTERNAL_SERVICE_SECRET` (`:59`); `ANTHROPIC_API_KEY` (`:82`); `OPENAI_API_KEY`
(`:88`); `LITELLM_MASTER_KEY` (`:93`); `MODEL_ROUTER_INTERNAL_SERVICE_TOKEN`
(`:100`); `MODEL_ROUTER_SIGNING_PRIVATE_KEY` (`:107`);
`PROVIDER_KEY_ENCRYPTION_KEY` (`:112`); `CHAT_CALLBACK_TOKEN` (`:119`);
`AUTH_KEYCLOAK_ID`/`AUTH_KEYCLOAK_SECRET`/`AUTH_SECRET` (`:140,145,150`);
`TEST_USER_USERNAME`/`TEST_USER_PASSWORD` (`:156,160`);
`AKM_INTERNAL_SERVICE_TOKEN`/`AKM_SIGNING_PRIVATE_KEY`/`AKM_SIGNING_PUBLIC_KEY`
(`:189,195,200`); AppRole entries for api, ai, ui, knowledge (`:231,232,234,239`);
the three `excluded_vars` at `:17-19` (Discord and Tavily tokens).

**Remove with their stacks:** `DB_USER`, `DB_PASSWORD`, `DB_NAME` (`:23,32,41`);
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (`:65,73`); `KC_ADMIN_USERNAME`,
`KC_ADMIN_PASSWORD` (`:125,130`); `SMTP_PASSWORD` (`:135`); AppRole entries for
db, auth, minio (`:229,233,235`).

**Keep:** `TRAEFIK_ADMIN_PASSWORD_HASH` (`:169`), `ACME_EMAIL` (`:173`),
`ACME_CA_SERVER` (`:177`), `HOSTINGER_API_KEY` (`:183`),
`GRAFANA_ADMIN_PASSWORD` (`:205`), the bootstrap secrets (`:213-217`), and
AppRoles for infra and observability (`:236,237`).

**Partially keep:** `vault_management_secrets` (`:220-224`) keeps
`OPENBAO_UNSEAL_KEY` and `VAULT_SYNC_TOKEN` but **loses
`VAULT_OIDC_CLIENT_SECRET` (`:223`)**, which is a Keycloak client secret. Remove
it from the schema and from `infra/secrets/prod.enc.env.example:86` and the
encrypted `prod.enc.env`. See §2.9.

**Trap:** `scripts/validate.sh:262-265` hard-codes `JWT_SECRET`, `DB_USER`,
`DB_PASSWORD` and `DB_NAME` in `required_secrets`. Dropping them from SOPS
without editing that list makes `validate.sh secrets` — and therefore
`make validate` — fail.

`vault.sh` must be pruned in the same step: `VAULT_SERVICES` (`:16`) and the
seeded app paths `secret/api/config` (`:314`), `secret/ai/config` (`:321`),
`secret/ui/config` (`:335`), `secret/mcp/config` (`:389`),
`secret/knowledge/config` (`:401`), `secret/shared/model-router` (`:421-447`),
`secret/shared/chat` (`:381`).

### 2.6 Tests

**`tests/checks/test_deploy_scope.py`** fails immediately on any `deploy.yml`
edit. `test_trigger_paths_exact_list` (`:188-215`) asserts an exact 19-entry
list. Rewrite it to the surviving set, and delete the per-service tests at
`:100-110`, `:160-173`, `:217-218`, `:253-255`.

**`tests/checks/test_secrets_schema.py:157-167`** runs the real validator and
asserts both `returncode == 0` and `"[WARN]" not in stdout`. Deleting app
compose files without pruning the schema fires the declared-vs-actual
`compose_refs` rule for every affected key. Schema and compose must move together.

**`tests/scripts/deploy.bats`** — `:74-82` asserts the deploy loop contains
`auth api ai mcp ui`; `:246-249` greps `services/mcp/Dockerfile`; `:298-306`
assert `deploy.sh` builds `hill90/agentbox` and references
`hill90/knowledge:latest`; `:327-338` assert exact `vault_paths_for_service`
strings for api, ai, ui.

**`tests/scripts/validate.bats`** carries 53 Keycloak references. Concretely:
`:265-273` (mcp compose), `:279-297` (UI health route and `KEYCLOAK_INTERNAL_URL`),
`:396-422` (`services/ui/src/auth.ts` and NextAuth route, `AUTH_KEYCLOAK_*`),
`:428-431` (`services/api/jest.config.js`). The Keycloak realm and theme blocks
go with the auth stack.

**`tests/scripts/rollback.bats:111-117`** asserts `rollback.sh paths api` emits
`services/api` — change in lockstep with `scripts/rollback.sh:47`.

**`tests/scripts/{vault,ops,backup,hostinger}.bats`** need lighter edits for
removed stacks: `vault.bats` (Keycloak references, `VAULT_SERVICES`, and the six
OIDC assertions at `:239-266` — see §2.9), `ops.bats`
(MinIO volume and health), `backup.bats` (db and minio targets), `hostinger.bats`
(storage DNS record).

**Keep the `deploy-db` Makefile target check** at `validate.bats:303-321`
in mind — it asserts `Makefile` has a `deploy-db` target. That assertion must be
removed when the db stack goes.

### 2.7 Docs, README, Makefile

**`README.md`** (669 lines): rewrite `:1-53` (title, architecture, key features,
services table); prune `:60-62` (Node/Python/Poetry prerequisites); remove
`:173-184` and `:212` (deploy application services); delete `:221-260`
(Development) entirely; prune the Makefile table rows at `:290,294-295,306`;
edit CI/CD `:359-368`, Manual Deployment `:405-408`, Monitoring `:420-422,450-452`,
Security `:471-480`, Troubleshooting `:517-521`, Documentation `:574,592`, and
VPS Rebuild `:621-622,657-660`.

**`CONTRIBUTING.md`**: update the scope callout `:6-9`; delete command-map rows
`:74-83`; delete the two dead reference links `:118` (`api-auth-verification.md`)
and `:125` (`mcp-gateway-evaluation.md`); delete the public-docs block `:136-139`;
delete the OpenAPI guardrail `:147-148`.

**`Makefile`**: delete `deploy-api` (`:184-186`), `build-agentbox` (`:188-190`),
`deploy-ai` (`:192-194`), `deploy-mcp` (`:196-198`), `deploy-ui` (`:200-202`),
`deploy-knowledge` (`:204-206`), `deploy-all` (`:212-214`), `deploy-db` (`:168`),
`deploy-minio` (`:172`), `deploy-auth` (`:180`); the dev targets `dev`/`dev-logs`/
`dev-down` (`:104-114`); the app arms of `test` (`:119,121,123`), `lint`
(`:133,135`) and `format` (`:140,142`); the `.PHONY` list (`:1`); help examples
(`:26,28`); the `config-vps` echo (`:97`); the `ps` grep list (`:235`); and the
rollback usage examples (`:305,312`).

**Markdown links that break** — these are hard CI failures via
`scripts/checks/check_md_links.py` (`ci.yml:20-21`), all from files that survive:

| Source | Dead target |
|---|---|
| `README.md:592` | `docs/development/local-setup.md` |
| `CONTRIBUTING.md:118` | `docs/runbooks/api-auth-verification.md` |
| `CONTRIBUTING.md:125` | `docs/architecture/mcp-gateway-evaluation.md` |
| `docs/architecture/overview.md:93,156` | `./agent-harness.md` |
| `docs/architecture/overview.md:155` | `./ui-components.md` |
| `docs/architecture/security.md:109` | `./agent-identity-model.md` |

Inline `services/...` mentions in prose are **not** caught by the link checker
(they are backticks or table cells, not markdown links). They become silently
wrong. Audit `docs/reference/deployment.md:128-131`, `README.md:229,234`,
`CONTRIBUTING.md:147`.

### 2.8 DNS

| File | Change |
|---|---|
| `infra/dns/hill90.com.json` | Remove the `api` and `ai` A records; remove `auth` and `storage` with their stacks. |
| `scripts/hostinger.sh:356` | Prune `api`, `ai`, `auth`, `storage`, `litellm` from the sync pair list. |
| `scripts/hostinger.sh:386-395` | Same, in the JSON payload builder. |
| `scripts/hostinger.sh:431,456` | Same, in the two verify loops. |
| `tests/scripts/hostinger.bats` | Assertions for the storage record. |

Actual DNS records are **not** changed by this work — only the automation that
would recreate them. Retiring `api.hill90.com`, `ai.hill90.com`,
`auth.hill90.com`, `storage.hill90.com` and `litellm.hill90.com` at Hostinger is
a separate, explicitly-approved operation.

### 2.9 OpenBao loses SSO — the Keycloak/vault coupling

**This is the one place where a KEEP and a REMOVE are coupled**, and it was
missed in the original decision. Found by cross-reading against the `hill90-app`
lane and verified directly.

`scripts/vault.sh:222-273` (`cmd_setup_oidc`) wires OpenBao's UI login to
Keycloak:

```sh
oidc_discovery_url="https://auth.hill90.com/realms/hill90"
oidc_client_id="hill90-vault"
bao_exec_env policy write policy-oidc-admin "/openbao/policies/policy-oidc-admin.hcl"
# role admin-sso, bound_claims {"realm_roles":["admin"]}
```

`cmd_setup` calls it conditionally at `:202-208`, when `VAULT_OIDC_CLIENT_SECRET`
is present in SOPS.

**Consequence, accepted:** removing Keycloak means **OpenBao loses SSO and falls
back to token auth**. That is acceptable for a single operator, and token auth is
already how every script authenticates — `vault_login()` uses AppRole
(`_common.sh:108-137`), and `sync-to-sops`, `seed` and `export` all take
`BAO_TOKEN`. Only the human-facing web UI login changes.

**The failure mode if this is not handled is silent, not loud.** `cmd_setup`
skips OIDC without error when the secret is absent (`:204-208`), so nothing
breaks visibly — the repo would simply retain a code path pointing at a deleted
realm on a hostname removed from DNS automation, and a vault policy no principal
can obtain. That is worse than absence.

Remove all of the following **in the same step as Keycloak** (Step 2):

| Surface | Location |
|---|---|
| `cmd_setup_oidc` function | `scripts/vault.sh:222-273` |
| Conditional call site in `cmd_setup` | `scripts/vault.sh:201-209` |
| Dispatcher arm | `scripts/vault.sh:863` |
| Usage line | `scripts/vault.sh:33` |
| Usage comment header | `scripts/vault.sh:3` |
| The policy file | `platform/vault/policies/policy-oidc-admin.hcl` |
| Schema entry | `platform/vault/secrets-schema.yaml:223` |
| SOPS example key | `infra/secrets/prod.enc.env.example:86` |
| SOPS real key | `infra/secrets/prod.enc.env` (`VAULT_OIDC_CLIENT_SECRET`) |
| Six bats assertions | `tests/scripts/vault.bats:239-266` |
| Docs — OIDC SSO section | `docs/architecture/secrets-model.md:71-78` |
| Docs — DR secrets table row | `docs/architecture/secrets-model.md:120` |

`platform/auth/keycloak/setup-realm.sh:337,341`, which instructs the operator to
create the client and run `vault.sh setup-oidc`, is deleted with the auth stack
anyway.

`cmd_policy_apply` globs `policy-*.hcl` (`vault.sh:461`), so deleting the policy
file is sufficient — no list needs editing.

**Replace, do not merely delete, the docs section.** `docs/architecture/secrets-model.md`
must state that vault UI access is token-only: obtain a token via
`vault.sh init` output or `bao operator generate-root`, and revoke it after use.
Leaving the section absent invites someone to re-add SSO without knowing it was
deliberately dropped.

---

## 3. Migration steps

**Gate — hard precondition.** No deletion in this repository may begin until the
`hill90-app` extraction is complete and verified: `services/` extracted with
history, `docs/site/` transferred, and the new repository confirmed to build. If
that lane is not finished, this work stops here.

Each step is one pull request. CI must be green before the next begins.

### Step 0 — Prepare

1. Rebase this branch onto `origin/main` (`f03f12d`, PR #493 — the Tailscale IP
   correction). The branch is currently one commit behind.
2. Confirm the `hill90-app` extraction is complete.
3. Create and push the annotated tag on the last commit containing the full tree:
   ```sh
   git tag -a archive/app-stack-final -m "Last commit containing the full services/ application stack"
   git push origin archive/app-stack-final
   ```

**Verify:** the tag exists on `origin`; `git show archive/app-stack-final:services/api/package.json` resolves.

### Step 1 — Remove the application services

Delete `services/{api,ai,ui,mcp,knowledge,agentbox,cli,discord-bot}`,
`deploy/compose/prod/docker-compose.{api,ai,ui,mcp,knowledge,agentbox-images,discord-bot}.yml`,
`deploy/compose/dev/`, `platform/ai/`, `scripts/provision-{akm,litellm}-db.sh`,
`packages/common`, `tests/e2e/`, and the five manual app deploy workflows plus
`smoke-auth.yml`.

In the same PR: `deploy.sh` app arms (§2.2), `ci.yml` app steps (§2.4),
`deploy.yml` app paths and jobs (§2.4), `test_deploy_scope.py` rewrite,
`deploy.bats` and `validate.bats` app assertions, the app entries in
`secrets-schema.yaml` and `prod.enc.env.example`, `vault.sh` app paths and
policies, `_common.sh:152-166`, `rollback.sh:47-52`, `ops.sh:33-34`,
`middlewares.yml` `mcp-strip`, `01-system-prep.yml:62`, the app DNS entries,
Makefile app targets, and `check_legacy_agentbox.sh`.

**Verify:** full CI green. `bash scripts/validate.sh all`.
`docker compose config` on all six remaining prod compose files. Confirm
`grep -rn "services/api\|services/ui\|litellm\|model-router" --exclude-dir=.git .`
returns only `docs/decisions/` hits.

**Live impact:** none. Nothing removed here is deployed.

### Step 2 — Remove Keycloak, Postgres and MinIO

Delete `deploy/compose/prod/docker-compose.{auth,db,minio}.yml`,
`platform/auth/`, `platform/data/`,
`platform/vault/policies/policy-{auth,db,minio,oidc-admin}.hcl`,
and `.github/workflows/deploy-{auth,db,minio}.yml`.

Edit: `deploy.sh` remaining arms; `backup.sh` targets; `ops.sh` MinIO health;
`check_volume_names.py:23-29`; `validate.sh:262-267` required-secrets;
`hostinger.sh` auth and storage records; `infra/dns/hill90.com.json`;
`secrets-schema.yaml` and `prod.enc.env.example` DB/MinIO/Keycloak keys;
`vault.sh` `VAULT_SERVICES`; the bats suites; Makefile targets.

**Also in this step, per §2.9 — the vault OIDC teardown.** Remove
`cmd_setup_oidc` and its call site, dispatcher arm and usage lines from
`vault.sh`; remove `VAULT_OIDC_CLIENT_SECRET` from the schema, the SOPS example
and the encrypted secrets; remove the six `vault.bats` OIDC assertions; and
rewrite the OIDC SSO section of `docs/architecture/secrets-model.md` to state
that vault UI access is token-only. This must not slip to Step 4 — leaving it
until the docs pass means shipping a `vault.sh` that points at a realm deleted
earlier in the same step.

**Verify:** full CI green. `validate.sh all`. Confirm `deploy.sh` usage lists
only `infra`, `vault`, `observability`, `verify`, `backup`, `help`. Confirm
`bash scripts/vault.sh help` no longer offers `setup-oidc`, and that
`grep -rn "oidc" --exclude-dir=.git .` returns nothing outside
`docs/decisions/`.

**Live impact:** none — none of the three is running, and OpenBao is not
deployed either, so the OIDC auth method exists in no running instance.

### Step 3 — Update the observability configuration

Prometheus scrape targets, the Postgres alert, and the three Grafana dashboards
(§2.3).

**Verify:** `docker compose config` on the observability stack; a YAML parse of
`prometheus.yml` and `alerts.yml`. Then, **with explicit approval in the same
turn**, redeploy observability on the VPS and confirm: seven containers still
up, Prometheus `/targets` shows no permanently-down job, Grafana loads with no
dashboard provisioning errors in its logs.

**Live impact: this is the only step that touches a running stack.** It is
deliberately isolated so it can be rolled back on its own.

### Step 4 — Documentation

Remove the 13 app docs; edit the mixed ones; rewrite `README.md` and
`CONTRIBUTING.md`; fix the six broken links in §2.7; update
`docs/decisions/infra-app-separation.md` from "decided, not implemented" to
implemented, linking `PRD.md` and `SPEC.md`.

**Verify:** `python3 scripts/checks/check_md_links.py` reports zero broken links.
Read `CONTRIBUTING.md`'s command map top to bottom and confirm every command runs.

### Step 5 — Final verification

Full CI. `validate.sh all`. Then, with approval: `deploy.sh infra prod` and
`deploy.sh observability prod` on the VPS, `deploy.sh verify infra` and
`deploy.sh verify observability`, and a container census confirming the same ten
containers.

---

## 4. Verification plan

### Static — runnable locally, no VPS

| Check | Command | Gate |
|---|---|---|
| Markdown links | `python3 scripts/checks/check_md_links.py` | hard fail |
| Secrets schema | `python3 scripts/checks/check_secrets_schema.py` | advisory, but `test_secrets_schema.py:157-167` makes warnings a hard fail |
| Volume names | `python3 scripts/checks/check_volume_names.py` | hard fail |
| Destructive commands | `bash scripts/checks/check_destructive_commands.sh` | hard fail |
| Shellcheck | `shellcheck --severity=error scripts/*.sh` | hard fail |
| Bats | `bats tests/scripts/` | hard fail |
| Pytest | `pytest tests/checks/ -v` | hard fail |
| Compose | `docker compose -f <each> config` | hard fail |
| Traefik | `bash scripts/validate.sh traefik` | hard fail |
| Everything | `bash scripts/validate.sh all` | — |

### Runtime — VPS, requires explicit approval in the same turn

```sh
ssh deploy@remote.hill90.com 'docker ps --format "{{.Names}}"'          # census
ssh deploy@remote.hill90.com 'cd /opt/hill90/app && bash scripts/deploy.sh verify infra'
ssh deploy@remote.hill90.com 'cd /opt/hill90/app && bash scripts/deploy.sh verify observability'
```

Expected census, unchanged throughout: `traefik`, `dns-manager`, `portainer`,
`prometheus`, `grafana`, `loki`, `tempo`, `promtail`, `cadvisor`, `node-exporter`.

Post-Step-3 additional checks: Prometheus `/targets` shows no permanently-down
job; Grafana logs contain no dashboard provisioning errors; certificate renewal
still works (Traefik logs, `dns-manager` reachable).

**Standing rule:** deploys run on the VPS over SSH, never from the Mac, and
never without asking in the same turn. Read-only inspection over SSH is fine.

---

## 5. Rollback

Rollback is cheap because the removals are subtractive and history is preserved
in three places: the `archive/app-stack-final` tag, the `hill90-app` repository,
and ordinary git history.

| Scenario | Response |
|---|---|
| CI fails on a step | Fix forward on the branch. Nothing is merged until green. |
| A merged step breaks something | `git revert` that step's squash commit. Each step is one self-contained PR. |
| **Step 3 breaks observability** | The real risk. Revert the config commit and redeploy: `deploy.sh observability prod`. Config is bind-mounted, so a revert plus redeploy fully restores prior behaviour — no image rebuild, no data migration. Grafana dashboards and Prometheus data live in named volumes untouched by this work. |
| A removed service is needed again | Restore from `archive/app-stack-final` or `hill90-app`. Keycloak, Postgres and MinIO are stock upstream images; their compose files are small and recoverable from the tag. |
| Total loss | `docs/runbooks/vps-rebuild.md` and `disaster-recovery.md` remain the recovery path, and remain in scope. |

No step deletes a Docker volume or mutates production data. No step is
irreversible.

---

## 6. Open items and known drift

1. **OpenBao is kept but is not deployed.** No `openbao` container runs on the
   host, so deploys currently take the SOPS fallback in `scripts/_common.sh:102-106`,
   and `infra/systemd/hill90-vault-unseal.service` targets a container that does
   not exist. Retaining it is defensible — it is the secrets architecture, and
   `check_secrets_schema.py`, `vault.sh` and the weekly sync workflow all assume
   it. But after this work Hill90 will document a vault-first secrets model whose
   vault is dormant. **Recommendation:** either redeploy the vault stack or add a
   note to `docs/architecture/secrets-model.md` stating that SOPS is the active
   path today. Not blocking; needs a decision.
2. **OpenBao loses SSO — recorded consequence, accepted.** Keeping OpenBao while
   removing Keycloak was decided without knowing the two were coupled through
   `vault.sh cmd_setup_oidc`. The decision stands; the consequence is that vault
   UI access becomes token-only. This is acceptable for a single operator, and
   every script already authenticates by token or AppRole — but it is a real
   capability loss, not a no-op, and it is why §2.9 exists. If SSO is ever wanted
   back, it needs an identity provider, which means re-adding Keycloak or
   adopting a lighter one.
3. **DNS drift, out of scope but recorded.** `vps.hill90.com` and
   `openclaw.hill90.com` still resolve to a stale address. Separately, `admin`
   and `grafana` records exist in `scripts/hostinger.sh:356` but not in
   `infra/dns/hill90.com.json` — the two DNS sources disagree.
4. **`docs/site/` handoff must be coordinated** with the `hill90-app` lane, not
   performed unilaterally. `docs.hill90.com` publishes via the Mintlify GitHub
   App, not a workflow in this repo, so retiring or repointing the domain is a
   separate action on Mintlify's side.
5. **`check_docs_secrets.sh` becomes a no-op** once `docs/site/` leaves (it skips
   cleanly when the directory is absent). Keeping or removing it is an
   implementation-time judgement call.
6. **`packages/common` can be deleted independently** of this work. It has zero
   consumers and is unrelated to the app/infra boundary.

---

## 7. Boundary summary for the template lane

The generic, reusable pattern in Hill90 — the part `docker-infra-template`
should lift — is:

**Provisioning:** `infra/ansible/` (OS prep, firewalld, Tailscale, SSH lockdown,
Docker, SOPS/age, secrets, deploy profile), `scripts/vps.sh`, `scripts/hostinger.sh`.

**Edge:** `docker-compose.infra.yml` as the sole network owner, Traefik with
both HTTP-01 and DNS-01 resolvers, a DNS-01 webhook service, Portainer,
`platform/edge/dynamic/middlewares.yml`.

**Observability:** `docker-compose.observability.yml` — the full LGTM stack plus
node-exporter and cAdvisor, with provisioning-as-code under
`platform/observability/`.

**Secrets:** SOPS/age at rest, OpenBao at runtime, and the
schema-validation pattern — `platform/vault/secrets-schema.yaml` plus
`scripts/checks/check_secrets_schema.py` cross-checking vault paths against SOPS
keys against compose `${VAR}` references. This is the most transferable idea in
the repository.

**Operations:** `deploy.sh` with its stateful/stateless distinction, pre-deploy
backup, health verification and diagnostic dump; `backup.sh` volume
backup/restore/prune; `rollback.sh` change-class-aware rollback; the reusable
GitHub Actions deploy workflow with Tailscale and SOPS.

**The anti-patterns to avoid carrying over**, all learned here:

- A single compose file owning networks that other stacks declare external
  (`docker-compose.api.yml:16-23`) — it makes stack removal order-dependent.
- Tests asserting the exact contents of a CI workflow
  (`test_deploy_scope.py:188-215`) — every legitimate change breaks them.
- A config file that is simultaneously a CI input and a runtime bind mount
  (`platform/vault/secrets-schema.yaml`).
- Hard-coded service lists in shared helpers (`_common.sh:152-166`,
  `validate.sh:262-267`, `vault.sh:16`) rather than derivation from what exists.
- One deploy dispatcher arm listing twelve stack names (`deploy.sh:655`).
