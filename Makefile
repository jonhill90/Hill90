.PHONY: help build deploy-infra deploy-infra-production deploy-db deploy-auth deploy-minio deploy-vault deploy-observability test logs health ssh secrets-edit secrets-init secrets-view secrets-update ps snapshot recreate-vps config-vps harden-ssh harden-ssh-check validate docs-dev backup backup-list backup-prune backup-restore rollback rollback-classify down dns-view dns-sync dns-verify vault-init vault-unseal vault-auto-unseal vault-status vault-setup vault-seed vault-sync-to-sops vault-setup-sync-token vault-bootstrap-approles check-secrets-schema

# Environment
ENV ?= prod
# Legacy COMPOSE_FILE removed — use per-service deploy targets instead
VPS_HOST ?= $(shell grep VPS_HOST infra/secrets/$(ENV).dec.env 2>/dev/null | cut -d '=' -f 2)

# Colors for output
COLOR_RESET = \033[0m
COLOR_BOLD = \033[1m
COLOR_GREEN = \033[32m
COLOR_YELLOW = \033[33m
COLOR_BLUE = \033[36m

# ============================================================================
# Help & Information
# ============================================================================

help: ## Show this help message
	@echo "$(COLOR_BOLD)Hill90 VPS Management$(COLOR_RESET)"
	@echo ""
	@echo "$(COLOR_BLUE)Available commands:$(COLOR_RESET)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(COLOR_GREEN)%-25s$(COLOR_RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(COLOR_BLUE)Per-service commands:$(COLOR_RESET)"
	@echo "  $(COLOR_GREEN)logs-<service>            $(COLOR_RESET) Show logs (e.g., make logs-traefik)"
	@echo "  $(COLOR_GREEN)restart-<service>         $(COLOR_RESET) Restart (e.g., make restart-traefik)"
	@echo "  $(COLOR_GREEN)exec-<service>            $(COLOR_RESET) Shell in (e.g., make exec-auth)"
	@echo ""
	@echo "$(COLOR_YELLOW)Environment:$(COLOR_RESET) $(ENV)"

# ============================================================================
# Infrastructure Setup (One-time or Rare)
# ============================================================================

secrets-init: ## Initialize SOPS keys
	@echo "$(COLOR_BOLD)Initializing SOPS keys...$(COLOR_RESET)"
	bash scripts/secrets.sh init

secrets-edit: ## Edit encrypted secrets interactively
	@echo "$(COLOR_BOLD)Editing $(ENV) secrets...$(COLOR_RESET)"
	sops infra/secrets/$(ENV).enc.env

secrets-view: ## View all secrets or specific key (usage: make secrets-view KEY=VPS_IP)
	@if [ -z "$(KEY)" ]; then \
		bash scripts/secrets.sh view infra/secrets/$(ENV).enc.env; \
	else \
		bash scripts/secrets.sh view infra/secrets/$(ENV).enc.env $(KEY); \
	fi

secrets-get: ## Get raw secret value, no ANSI (usage: make secrets-get KEY=VPS_IP)
	@if [ -z "$(KEY)" ]; then \
		echo "$(COLOR_RED)Error: KEY is required$(COLOR_RESET)"; \
		exit 1; \
	fi
	@bash scripts/secrets.sh get infra/secrets/$(ENV).enc.env "$(KEY)"

secrets-update: ## Update a secret value (usage: make secrets-update KEY=VPS_IP VALUE="1.2.3.4")
	@if [ -z "$(KEY)" ] || [ -z "$(VALUE)" ]; then \
		echo "$(COLOR_RED)Error: KEY and VALUE are required$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Usage: make secrets-update KEY=<key> VALUE=<value>$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Example: make secrets-update KEY=VPS_IP VALUE=\"1.2.3.4\"$(COLOR_RESET)"; \
		exit 1; \
	fi
	bash scripts/secrets.sh update infra/secrets/$(ENV).enc.env "$(KEY)" "$(VALUE)"

# ============================================================================
# VPS Rebuild & Bootstrap (DESTRUCTIVE)
# ============================================================================

snapshot: ## Create VPS snapshot (safety backup)
	@bash scripts/hostinger.sh vps snapshot create

recreate-vps: ## Recreate VPS via API (DESTRUCTIVE - rebuilds OS, auto-rotates Tailscale key)
	@bash scripts/vps.sh recreate

config-vps: ## Configure VPS OS only (no containers deployed)
	@if [ -z "$(VPS_IP)" ]; then \
		echo "$(COLOR_YELLOW)Error: VPS_IP is required$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Usage: make config-vps VPS_IP=<ip>$(COLOR_RESET)"; \
		exit 1; \
	fi
	@echo "$(COLOR_BOLD)Configuring VPS at $(VPS_IP)...$(COLOR_RESET)"
	@echo ""
	@echo "$(COLOR_GREEN)This will:$(COLOR_RESET)"
	@echo "  1. Run Ansible bootstrap (Docker, SOPS, age, Tailscale)"
	@echo "  2. Extract and update TAILSCALE_IP in secrets"
	@echo ""
	@echo "$(COLOR_YELLOW)⚠️  No containers deployed$(COLOR_RESET)"
	@echo ""
	bash scripts/vps.sh config $(VPS_IP)
	@echo ""
	@echo "$(COLOR_GREEN)✓ VPS configured!$(COLOR_RESET)"

harden-ssh-check: ## Dry run of harden-ssh — reports what would change, changes nothing
	bash scripts/vps.sh harden-ssh --check

harden-ssh: ## Re-apply firewall + SSH hardening only (02+04), against the known TAILSCALE_IP — h#681/h#786
	bash scripts/vps.sh harden-ssh

# ============================================================================
# Development
# ============================================================================

docs-dev: ## Run Mintlify docs site locally (port 3333)
	cd docs/site && npm run dev

test: ## Run all tests (infra + checks)
	@echo "$(COLOR_BOLD)Running all test suites...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Infrastructure tests (bats)...$(COLOR_RESET)"
	bats tests/scripts/*.bats || true
	@echo "$(COLOR_BLUE)Check scripts (pytest)...$(COLOR_RESET)"
	python3 -m pytest tests/checks/ -q || true
	@echo "$(COLOR_GREEN)All test suites complete!$(COLOR_RESET)"

validate: ## Validate infrastructure configuration (Traefik, secrets, Docker Compose)
	@echo "$(COLOR_BOLD)Validating infrastructure...$(COLOR_RESET)"
	@bash scripts/validate.sh all $(ENV)

# ============================================================================
# Deployment
# ============================================================================

build: ## Build all Docker images (per-service compose files)
	@echo "$(COLOR_BOLD)Building all Docker images...$(COLOR_RESET)"
	@for f in deploy/compose/$(ENV)/docker-compose.*.yml; do \
		echo "Building $$(basename $$f)..."; \
		docker compose -f "$$f" build --parallel || true; \
	done

deploy-infra: ## Deploy infrastructure (Traefik, Portainer)
	@echo "$(COLOR_YELLOW)Deploying infrastructure services...$(COLOR_RESET)"
	bash scripts/deploy.sh infra $(ENV)

# The ACME CA comes from the secrets store (vault secret/infra/traefik, SOPS as
# fallback). Both `sops exec-env` and the `set -a; source` in _common.sh REPLACE
# a caller-set ACME_CA_SERVER, so exporting it here would be inert — this target
# used to do exactly that, and it chose nothing.
#
# ACME_REQUIRE_PRODUCTION is not a secret, so the store cannot override it. The
# render refuses if the configured CA is staging, which turns the intent of this
# target into something enforced rather than merely stated.
deploy-infra-production: ## Deploy infrastructure, refusing to proceed unless the CA is production
	@echo "$(COLOR_BOLD)⚠️  WARNING: PRODUCTION CERTIFICATES ⚠️$(COLOR_RESET)"
	@echo "Refuses to deploy if the configured CA is Let's Encrypt staging."
	@read -p "Are you sure? (yes/no): " confirm && [ "$$confirm" = "yes" ]
	ACME_REQUIRE_PRODUCTION=1 bash scripts/deploy.sh infra $(ENV)

# h#831: deploy.sh has supported db/auth/minio as first-class targets since
# before this Makefile existed (its own usage text lists them) — nothing here
# ever exposed them as `make` targets, which is how vps-rebuild.md ended up
# with no step for any of the three: a runbook author reaching for the
# established `make deploy-X` convention here had nothing to reach for.
deploy-db: ## Deploy PostgreSQL (platform database)
	@echo "$(COLOR_YELLOW)Deploying PostgreSQL...$(COLOR_RESET)"
	bash scripts/deploy.sh db $(ENV)

# auth (Keycloak) stores realms in Postgres and refuses to deploy if it
# cannot query it (scripts/deploy.sh's own guard: "Cannot deploy auth: cannot
# query postgres... Deploy it first: bash scripts/deploy.sh db"). db must be
# deployed before this target, not just before it in a runbook's prose.
deploy-auth: ## Deploy Keycloak (platform identity provider) — requires deploy-db first
	@echo "$(COLOR_YELLOW)Deploying Keycloak...$(COLOR_RESET)"
	bash scripts/deploy.sh auth $(ENV)

deploy-minio: ## Deploy MinIO object store (platform storage)
	@echo "$(COLOR_YELLOW)Deploying MinIO...$(COLOR_RESET)"
	bash scripts/deploy.sh minio $(ENV)

deploy-vault: ## Deploy OpenBao secrets management
	@echo "$(COLOR_YELLOW)Deploying OpenBao vault...$(COLOR_RESET)"
	bash scripts/deploy.sh vault $(ENV)

deploy-observability: ## Deploy observability stack (Grafana, Prometheus, Loki, Tempo)
	@echo "$(COLOR_YELLOW)Deploying observability stack...$(COLOR_RESET)"
	bash scripts/deploy.sh observability $(ENV)

# ============================================================================
# Monitoring & Maintenance
# ============================================================================

health: ## Check service health
	@echo "$(COLOR_BOLD)Checking service health...$(COLOR_RESET)"
	bash scripts/ops.sh health

logs: ## Show recent logs for all services (use logs-<name> to follow specific)
	@docker ps --format '{{.Names}}' | while read -r name; do \
		echo "=== $$name ==="; \
		docker logs --tail=20 "$$name" 2>&1 || true; \
		echo ""; \
	done

logs-%: ## Show logs for a service (e.g., make logs-traefik)
	docker logs -f $*

ps: ## Show running containers
	docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(NAMES|traefik|portainer|openbao|prometheus|grafana|loki|tempo|promtail|cadvisor|node-exporter)" || true

ssh: ## SSH into VPS
	@if [ -z "$(VPS_HOST)" ]; then \
		echo "$(COLOR_YELLOW)VPS_HOST not set. Please set it in $(ENV) secrets or pass VPS_HOST=<host>$(COLOR_RESET)"; \
		exit 1; \
	fi
	ssh deploy@$(VPS_HOST)

# ============================================================================
# DNS Management
# ============================================================================

# DNS is Cloudflare. Hostinger remains the VPS host and the mail provider.
#
# dns-snapshots and dns-restore are gone: they wrapped Hostinger's zone-snapshot
# API, which Cloudflare has no equivalent of. Cloudflare keeps its own change
# history per record in the dashboard. Rolling a record back is `make dns-sync`
# with the right IP, because sync is idempotent and per-record.

dns-view: ## View the managed DNS records for hill90.com
	@bash scripts/cloudflare.sh dns get

dns-sync: ## Sync DNS A records to current VPS_IP
	@bash scripts/cloudflare.sh dns sync

dns-verify: ## Verify DNS propagation
	@bash scripts/cloudflare.sh dns verify

# ============================================================================
# Service Management
# ============================================================================

down: ## Stop a service (usage: make down-<service>)
	@echo "Use 'make down-<service>' for targeted shutdown"
	@echo "Full platform shutdown requires VPS SSH maintenance window"

down-%: ## Stop a specific service (e.g., make down-observability)
	docker stop $* && docker rm $* || true

restart-%: ## Restart a service (e.g., make restart-traefik)
	docker restart $*

exec-%: ## Shell into a container (e.g., make exec-traefik)
	docker exec -it $* sh

# ============================================================================
# Database & Backups
# ============================================================================

backup: ## Backup all critical volumes (infra, observability, vault)
	@echo "$(COLOR_BOLD)Creating backup...$(COLOR_RESET)"
	bash scripts/backup.sh backup-all

backup-%: ## Backup a specific service (e.g., make backup-infra)
	@echo "$(COLOR_BOLD)Backing up $*...$(COLOR_RESET)"
	bash scripts/backup.sh backup $*

backup-list: ## List available backups
	bash scripts/backup.sh list

backup-prune: ## Delete backups older than 7 days (override: RETENTION_DAYS=N)
	bash scripts/backup.sh prune $(RETENTION_DAYS)

backup-restore: ## Restore from backup (usage: make backup-restore SERVICE=infra BACKUP_PATH=/opt/hill90/backups/infra/20260222_120000)
	@if [ -z "$(SERVICE)" ] || [ -z "$(BACKUP_PATH)" ]; then \
		echo "$(COLOR_YELLOW)Usage: make backup-restore SERVICE=db BACKUP_PATH=/path/to/backup$(COLOR_RESET)"; \
		exit 1; \
	fi
	bash scripts/backup.sh restore $(SERVICE) $(BACKUP_PATH)

rollback: ## Rollback a service (usage: make rollback SERVICE=observability REF=HEAD~1)
	@if [ -z "$(SERVICE)" ]; then \
		echo "$(COLOR_YELLOW)Usage: make rollback SERVICE=<service> [REF=<git-ref>]$(COLOR_RESET)"; \
		exit 1; \
	fi
	bash scripts/rollback.sh rollback $(SERVICE) $(REF)

rollback-classify: ## Classify changes for a service (usage: make rollback-classify SERVICE=observability REF=HEAD~1)
	@if [ -z "$(SERVICE)" ]; then \
		echo "$(COLOR_YELLOW)Usage: make rollback-classify SERVICE=<service> [REF=<git-ref>]$(COLOR_RESET)"; \
		exit 1; \
	fi
	bash scripts/rollback.sh classify $(SERVICE) $(REF)

# ============================================================================
# Vault (OpenBao) Management
# ============================================================================

vault-init: ## Initialize OpenBao (generates unseal key + root token)
	bash scripts/vault.sh init

vault-unseal: ## Unseal OpenBao using host key file or SOPS fallback
	bash scripts/vault.sh unseal

vault-status: ## Show OpenBao seal/init status
	bash scripts/vault.sh status

vault-setup: ## Enable KV v2, AppRole, audit, apply policies, create roles
	bash scripts/vault.sh setup

vault-seed: ## Seed KV v2 paths from SOPS-encrypted secrets
	bash scripts/vault.sh seed

vault-sync-to-sops: ## Sync vault secrets back to SOPS backup
	bash scripts/vault.sh sync-to-sops

vault-auto-unseal: ## Wait for vault container + unseal (for deploy/systemd hooks)
	bash scripts/vault.sh auto-unseal

vault-bootstrap-approles: ## Generate AppRole credentials for all services and store in SOPS
	bash scripts/vault.sh bootstrap-approles

vault-setup-sync-token: ## Create read-only sync token and store in SOPS
	bash scripts/vault.sh setup-sync-token

check-secrets-schema: ## Validate vault/SOPS/compose schema consistency
	python3 scripts/checks/check_secrets_schema.py
