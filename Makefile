.PHONY: help build deploy deploy-production deploy-infra deploy-infra-production deploy-auth deploy-api deploy-ai deploy-mcp deploy-all test clean logs health ssh secrets-edit secrets-init secrets-view secrets-update lint format ps restart snapshot recreate-vps config-vps tailscale-setup tailscale-rotate validate dev dev-logs dev-down backup up down pull dns-view dns-sync dns-snapshots dns-restore dns-verify

# Environment
ENV ?= prod
COMPOSE_FILE = deployments/compose/$(ENV)/docker-compose.yml
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
	@echo "$(COLOR_YELLOW)Compose File:$(COLOR_RESET) $(COMPOSE_FILE)"

# ============================================================================
# Infrastructure Setup (One-time or Rare)
# ============================================================================

tailscale-setup: ## Setup Tailscale infrastructure (Terraform + secrets) - AUTOMATED
	@echo "$(COLOR_BOLD)Running automated Tailscale setup...$(COLOR_RESET)"
	bash scripts/infra/tailscale-setup.sh

tailscale-rotate: tailscale-setup ## Rotate Tailscale auth key (generates new key and updates secrets)
	@echo "$(COLOR_GREEN)Tailscale auth key rotated!$(COLOR_RESET)"

secrets-init: ## Initialize SOPS keys
	@echo "$(COLOR_BOLD)Initializing SOPS keys...$(COLOR_RESET)"
	bash scripts/secrets/secrets-init.sh

secrets-edit: ## Edit encrypted secrets interactively
	@echo "$(COLOR_BOLD)Editing $(ENV) secrets...$(COLOR_RESET)"
	sops infra/secrets/$(ENV).enc.env

secrets-view: ## View all secrets or specific key (usage: make secrets-view KEY=VPS_IP)
	@if [ -z "$(KEY)" ]; then \
		bash scripts/secrets/secrets-view.sh infra/secrets/$(ENV).enc.env; \
	else \
		bash scripts/secrets/secrets-view.sh infra/secrets/$(ENV).enc.env $(KEY); \
	fi

secrets-update: ## Update a secret value (usage: make secrets-update KEY=VPS_IP VALUE="1.2.3.4")
	@if [ -z "$(KEY)" ] || [ -z "$(VALUE)" ]; then \
		echo "$(COLOR_RED)Error: KEY and VALUE are required$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Usage: make secrets-update KEY=<key> VALUE=<value>$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Example: make secrets-update KEY=VPS_IP VALUE=\"1.2.3.4\"$(COLOR_RESET)"; \
		exit 1; \
	fi
	bash scripts/secrets/secrets-update.sh infra/secrets/$(ENV).enc.env "$(KEY)" "$(VALUE)"

# ============================================================================
# VPS Rebuild & Bootstrap (DESTRUCTIVE)
# ============================================================================

snapshot: ## Create VPS snapshot (safety backup)
	@bash scripts/infra/hostinger.sh vps snapshot create

recreate-vps: ## Recreate VPS via API (DESTRUCTIVE - rebuilds OS, auto-rotates Tailscale key)
	@bash scripts/infra/recreate-vps.sh

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
	bash scripts/infra/config-vps.sh $(VPS_IP)
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
	docker compose -f deployments/compose/dev/docker-compose.yml up -d

dev-logs: ## Show development logs
	docker compose -f deployments/compose/dev/docker-compose.yml logs -f

dev-down: ## Stop development environment
	docker compose -f deployments/compose/dev/docker-compose.yml down

test: ## Run all tests
	@echo "$(COLOR_BOLD)Running tests...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Testing API service...$(COLOR_RESET)"
	cd src/services/api && npm test || true
	@echo "$(COLOR_BLUE)Testing AI service...$(COLOR_RESET)"
	cd src/services/ai && poetry run pytest || true
	@echo "$(COLOR_BLUE)Testing Auth service...$(COLOR_RESET)"
	cd src/services/auth && npm test || true
	@echo "$(COLOR_GREEN)Tests complete!$(COLOR_RESET)"

lint: ## Lint all code
	@echo "$(COLOR_BOLD)Linting code...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Linting API service...$(COLOR_RESET)"
	cd src/services/api && npm run lint || true
	@echo "$(COLOR_BLUE)Linting AI service...$(COLOR_RESET)"
	cd src/services/ai && poetry run ruff check app/ || true
	@echo "$(COLOR_BLUE)Linting Auth service...$(COLOR_RESET)"
	cd src/services/auth && npm run lint || true

format: ## Format all code
	@echo "$(COLOR_BOLD)Formatting code...$(COLOR_RESET)"
	@echo "$(COLOR_BLUE)Formatting API service...$(COLOR_RESET)"
	cd src/services/api && npm run format || true
	@echo "$(COLOR_BLUE)Formatting AI service...$(COLOR_RESET)"
	cd src/services/ai && poetry run black app/ || true
	@echo "$(COLOR_BLUE)Formatting Auth service...$(COLOR_RESET)"
	cd src/services/auth && npm run format || true

validate: ## Validate infrastructure configuration (Traefik, secrets, Docker Compose)
	@echo "$(COLOR_BOLD)Validating infrastructure...$(COLOR_RESET)"
	@bash scripts/validate/validate-infra.sh $(ENV)

# ============================================================================
# Deployment
# ============================================================================

build: ## Build all Docker images
	@echo "$(COLOR_BOLD)Building all Docker images...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) build

deploy: ## [DEPRECATED] Use 'make deploy-infra' + 'make deploy-all'
	@echo "$(COLOR_YELLOW)⚠ 'make deploy' is deprecated. Use 'make deploy-infra' + 'make deploy-all'.$(COLOR_RESET)"
	bash scripts/deploy/deploy-infra.sh $(ENV)
	bash scripts/deploy/deploy-all.sh $(ENV)

deploy-production: ## [DEPRECATED] Use 'make deploy-infra-production' + 'make deploy-all'
	@echo "$(COLOR_YELLOW)⚠ 'make deploy-production' is deprecated. Use 'make deploy-infra-production' + 'make deploy-all'.$(COLOR_RESET)"
	@read -p "Are you sure? (yes/no): " confirm && [ "$$confirm" = "yes" ]
	ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory bash scripts/deploy/deploy-infra.sh $(ENV)
	bash scripts/deploy/deploy-all.sh $(ENV)

deploy-infra: ## Deploy infrastructure (Traefik, dns-manager, Portainer)
	@echo "$(COLOR_YELLOW)Deploying infrastructure services...$(COLOR_RESET)"
	bash scripts/deploy/deploy-infra.sh $(ENV)

deploy-infra-production: ## Deploy infrastructure with PRODUCTION certificates
	@echo "$(COLOR_BOLD)⚠️  WARNING: PRODUCTION CERTIFICATES ⚠️$(COLOR_RESET)"
	@read -p "Are you sure? (yes/no): " confirm && [ "$$confirm" = "yes" ]
	ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory bash scripts/deploy/deploy-infra.sh $(ENV)

deploy-auth: ## Deploy auth service (with PostgreSQL)
	@echo "$(COLOR_YELLOW)Deploying auth service...$(COLOR_RESET)"
	bash scripts/deploy/_service.sh auth $(ENV)

deploy-api: ## Deploy API service
	@echo "$(COLOR_YELLOW)Deploying API service...$(COLOR_RESET)"
	bash scripts/deploy/_service.sh api $(ENV)

deploy-ai: ## Deploy AI service
	@echo "$(COLOR_YELLOW)Deploying AI service...$(COLOR_RESET)"
	bash scripts/deploy/_service.sh ai $(ENV)

deploy-mcp: ## Deploy MCP service
	@echo "$(COLOR_YELLOW)Deploying MCP service...$(COLOR_RESET)"
	bash scripts/deploy/_service.sh mcp $(ENV)

deploy-all: ## Deploy all application services (NOT infrastructure)
	@echo "$(COLOR_YELLOW)Deploying all application services...$(COLOR_RESET)"
	bash scripts/deploy/deploy-all.sh $(ENV)

# ============================================================================
# Monitoring & Maintenance
# ============================================================================

health: ## Check service health
	@echo "$(COLOR_BOLD)Checking service health...$(COLOR_RESET)"
	bash scripts/ops/health-check.sh

logs: ## Show logs for all services
	docker compose -f $(COMPOSE_FILE) logs -f

logs-%: ## Show logs for a service (e.g., make logs-api)
	docker logs -f $*

ps: ## Show running containers
	docker compose -f $(COMPOSE_FILE) ps

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
	@bash scripts/infra/hostinger.sh dns get

dns-sync: ## Sync DNS A records to current VPS_IP
	@bash scripts/infra/hostinger.sh dns sync

dns-snapshots: ## List DNS backup snapshots
	@bash scripts/infra/hostinger.sh dns snapshot list

dns-restore: ## Restore DNS from snapshot (usage: make dns-restore SNAPSHOT_ID=123)
	@bash scripts/infra/hostinger.sh dns snapshot restore $(SNAPSHOT_ID)

dns-verify: ## Verify DNS propagation
	@bash scripts/infra/hostinger.sh dns verify

# ============================================================================
# Service Management
# ============================================================================

up: ## Start all services
	docker compose -f $(COMPOSE_FILE) up -d

down: ## Stop all services
	docker compose -f $(COMPOSE_FILE) down

restart: ## Restart all services
	@echo "$(COLOR_BOLD)Restarting all services...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) restart

restart-%: ## Restart a service (e.g., make restart-api)
	docker compose -f $(COMPOSE_FILE) restart $*

pull: ## Pull latest images
	docker compose -f $(COMPOSE_FILE) pull

exec-%: ## Shell into a container (e.g., make exec-api)
	docker compose -f $(COMPOSE_FILE) exec $* sh

clean: ## Clean up Docker resources
	@echo "$(COLOR_BOLD)Cleaning up Docker resources...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) down
	docker system prune -f
	@echo "$(COLOR_GREEN)Cleanup complete!$(COLOR_RESET)"

# ============================================================================
# Database & Backups
# ============================================================================

backup: ## Backup database and volumes
	@echo "$(COLOR_BOLD)Creating backup...$(COLOR_RESET)"
	bash scripts/ops/backup.sh
