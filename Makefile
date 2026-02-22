.PHONY: help build deploy-infra deploy-infra-production deploy-db deploy-minio deploy-observability deploy-auth deploy-api deploy-ai deploy-mcp deploy-agentbox deploy-ui deploy-all agentbox-list agentbox-status agentbox-generate test logs health ssh secrets-edit secrets-init secrets-view secrets-update lint format ps snapshot recreate-vps config-vps validate dev dev-logs dev-down backup down dns-view dns-sync dns-snapshots dns-restore dns-verify

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
	@echo "  $(COLOR_GREEN)logs-<service>            $(COLOR_RESET) Show logs (e.g., make logs-api)"
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
	@echo ""
	@echo "$(COLOR_YELLOW)Next: Deploy infrastructure and services$(COLOR_RESET)"
	@echo "  make deploy-infra    # Traefik, dns-manager, Portainer"
	@echo "  make deploy-all      # All app services"
	@echo ""

# ============================================================================
# Development
# ============================================================================

dev: ## Run development environment
	docker compose -f deploy/compose/dev/docker-compose.yml up -d

dev-logs: ## Show development logs
	docker compose -f deploy/compose/dev/docker-compose.yml logs -f

dev-down: ## Stop development environment
	docker compose -f deploy/compose/dev/docker-compose.yml down

test: ## Run all tests
	@echo "$(COLOR_BOLD)Running tests...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Testing API service...$(COLOR_RESET)"
	cd src/services/api && npm test || true
	@echo "$(COLOR_BLUE)Testing AI service...$(COLOR_RESET)"
	cd src/services/ai && poetry run pytest || true
	@echo "$(COLOR_GREEN)Tests complete!$(COLOR_RESET)"

lint: ## Lint all code
	@echo "$(COLOR_BOLD)Linting code...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Linting API service...$(COLOR_RESET)"
	cd src/services/api && npm run lint || true
	@echo "$(COLOR_BLUE)Linting AI service...$(COLOR_RESET)"
	cd src/services/ai && poetry run ruff check app/ || true

format: ## Format all code
	@echo "$(COLOR_BOLD)Formatting code...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Formatting API service...$(COLOR_RESET)"
	cd src/services/api && npm run format || true
	@echo "$(COLOR_BLUE)Formatting AI service...$(COLOR_RESET)"
	cd src/services/ai && poetry run black app/ || true

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

deploy-infra: ## Deploy infrastructure (Traefik, dns-manager, Portainer)
	@echo "$(COLOR_YELLOW)Deploying infrastructure services...$(COLOR_RESET)"
	bash scripts/deploy.sh infra $(ENV)

deploy-infra-production: ## Deploy infrastructure with PRODUCTION certificates
	@echo "$(COLOR_BOLD)⚠️  WARNING: PRODUCTION CERTIFICATES ⚠️$(COLOR_RESET)"
	@read -p "Are you sure? (yes/no): " confirm && [ "$$confirm" = "yes" ]
	ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory bash scripts/deploy.sh infra $(ENV)

deploy-db: ## Deploy database (PostgreSQL)
	@echo "$(COLOR_YELLOW)Deploying database...$(COLOR_RESET)"
	bash scripts/deploy.sh db $(ENV)

deploy-minio: ## Deploy MinIO object storage
	@echo "$(COLOR_YELLOW)Deploying MinIO storage...$(COLOR_RESET)"
	bash scripts/deploy.sh minio $(ENV)

deploy-auth: ## Deploy Keycloak identity provider
	@echo "$(COLOR_YELLOW)Deploying Keycloak...$(COLOR_RESET)"
	bash scripts/deploy.sh auth $(ENV)

deploy-api: ## Deploy API service
	@echo "$(COLOR_YELLOW)Deploying API service...$(COLOR_RESET)"
	bash scripts/deploy.sh api $(ENV)

deploy-ai: ## Deploy AI service
	@echo "$(COLOR_YELLOW)Deploying AI service...$(COLOR_RESET)"
	bash scripts/deploy.sh ai $(ENV)

deploy-mcp: ## Deploy MCP service
	@echo "$(COLOR_YELLOW)Deploying MCP service...$(COLOR_RESET)"
	bash scripts/deploy.sh mcp $(ENV)

deploy-agentbox: ## Deploy agent containers
	@echo "$(COLOR_YELLOW)Deploying AgentBox containers...$(COLOR_RESET)"
	bash scripts/deploy.sh agentbox $(ENV)

agentbox-list: ## List configured agents
	bash scripts/agentbox.sh list

agentbox-status: ## Show running agent containers
	bash scripts/agentbox.sh status

agentbox-generate: ## Regenerate compose from agent configs
	bash scripts/agentbox.sh generate

deploy-ui: ## Deploy UI service
	@echo "$(COLOR_YELLOW)Deploying UI service...$(COLOR_RESET)"
	bash scripts/deploy.sh ui $(ENV)

deploy-observability: ## Deploy observability stack (Grafana, Prometheus, Loki, Tempo)
	@echo "$(COLOR_YELLOW)Deploying observability stack...$(COLOR_RESET)"
	bash scripts/deploy.sh observability $(ENV)

deploy-all: ## Deploy all application services (NOT infrastructure)
	@echo "$(COLOR_YELLOW)Deploying all application services...$(COLOR_RESET)"
	bash scripts/deploy.sh all $(ENV)

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

logs-%: ## Show logs for a service (e.g., make logs-api)
	docker logs -f $*

ps: ## Show running containers
	docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "(NAMES|traefik|dns-manager|portainer|postgres|keycloak|api|ai|mcp|ui|minio|grafana|agentbox)" || true

ssh: ## SSH into VPS
	@if [ -z "$(VPS_HOST)" ]; then \
		echo "$(COLOR_YELLOW)VPS_HOST not set. Please set it in $(ENV) secrets or pass VPS_HOST=<host>$(COLOR_RESET)"; \
		exit 1; \
	fi
	ssh deploy@$(VPS_HOST)

# ============================================================================
# DNS Management
# ============================================================================

dns-view: ## View current DNS records for hill90.com
	@bash scripts/hostinger.sh dns get

dns-sync: ## Sync DNS A records to current VPS_IP
	@bash scripts/hostinger.sh dns sync

dns-snapshots: ## List DNS backup snapshots
	@bash scripts/hostinger.sh dns snapshot list

dns-restore: ## Restore DNS from snapshot (usage: make dns-restore SNAPSHOT_ID=123)
	@bash scripts/hostinger.sh dns snapshot restore $(SNAPSHOT_ID)

dns-verify: ## Verify DNS propagation
	@bash scripts/hostinger.sh dns verify

# ============================================================================
# Service Management
# ============================================================================

down: ## Stop a service (usage: make down-<service>)
	@echo "Use 'make down-<service>' for targeted shutdown"
	@echo "Full platform shutdown requires VPS SSH maintenance window"

down-%: ## Stop a specific service (e.g., make down-api)
	docker stop $* && docker rm $* || true

restart-%: ## Restart a service (e.g., make restart-api)
	docker restart $*

exec-%: ## Shell into a container (e.g., make exec-api)
	docker exec -it $* sh

# ============================================================================
# Database & Backups
# ============================================================================

backup: ## Backup database and volumes
	@echo "$(COLOR_BOLD)Creating backup...$(COLOR_RESET)"
	bash scripts/ops.sh backup
