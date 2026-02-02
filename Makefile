.PHONY: help build deploy deploy-production deploy-infra deploy-auth deploy-api deploy-ai deploy-mcp deploy-all test clean logs health ssh secrets-edit secrets-init secrets-view secrets-update bootstrap lint format ps restart snapshot rebuild rebuild-bootstrap rebuild-full rebuild-full-auto rebuild-full-auto-post-mcp rebuild-optimized rebuild-optimized-post-mcp tailscale-setup tailscale-rotate validate dev dev-logs dev-down backup up down pull exec-api exec-ai exec-auth

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
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(COLOR_GREEN)%-20s$(COLOR_RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(COLOR_YELLOW)Environment:$(COLOR_RESET) $(ENV)"
	@echo "$(COLOR_YELLOW)Compose File:$(COLOR_RESET) $(COMPOSE_FILE)"

# ============================================================================
# Infrastructure Setup (One-time or Rare)
# ============================================================================

tailscale-setup: ## Setup Tailscale infrastructure (Terraform + secrets) - AUTOMATED
	@echo "$(COLOR_BOLD)Running automated Tailscale setup...$(COLOR_RESET)"
	bash scripts/tailscale-setup.sh

tailscale-rotate: tailscale-setup ## Rotate Tailscale auth key (generates new key and updates secrets)
	@echo "$(COLOR_GREEN)Tailscale auth key rotated!$(COLOR_RESET)"

secrets-init: ## Initialize SOPS keys
	@echo "$(COLOR_BOLD)Initializing SOPS keys...$(COLOR_RESET)"
	bash scripts/secrets-init.sh

secrets-edit: ## Edit encrypted secrets interactively
	@echo "$(COLOR_BOLD)Editing $(ENV) secrets...$(COLOR_RESET)"
	sops infra/secrets/$(ENV).enc.env

secrets-view: ## View all secrets or specific key (usage: make secrets-view KEY=VPS_IP)
	@if [ -z "$(KEY)" ]; then \
		bash scripts/secrets-view.sh infra/secrets/$(ENV).enc.env; \
	else \
		bash scripts/secrets-view.sh infra/secrets/$(ENV).enc.env $(KEY); \
	fi

secrets-update: ## Update a secret value (usage: make secrets-update KEY=VPS_IP VALUE="1.2.3.4")
	@if [ -z "$(KEY)" ] || [ -z "$(VALUE)" ]; then \
		echo "$(COLOR_RED)Error: KEY and VALUE are required$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Usage: make secrets-update KEY=<key> VALUE=<value>$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Example: make secrets-update KEY=VPS_IP VALUE=\"1.2.3.4\"$(COLOR_RESET)"; \
		exit 1; \
	fi
	bash scripts/secrets-update.sh infra/secrets/$(ENV).enc.env "$(KEY)" "$(VALUE)"

# ============================================================================
# VPS Rebuild & Bootstrap (DESTRUCTIVE)
# ============================================================================

snapshot: ## Create VPS snapshot (safety backup)
	@echo "$(COLOR_BOLD)Creating VPS snapshot...$(COLOR_RESET)"
	bash scripts/vps-snapshot.sh

recreate-vps: ## Recreate VPS via API (DESTRUCTIVE - rebuilds OS, auto-rotates Tailscale key)
	@bash scripts/recreate-vps.sh

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
	bash scripts/config-vps.sh $(VPS_IP)
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
	@bash scripts/validate-infra.sh $(ENV)

# ============================================================================
# Deployment
# ============================================================================

build: ## Build all Docker images
	@echo "$(COLOR_BOLD)Building all Docker images...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) build

deploy: ## Deploy to VPS (STAGING certificates - safe for testing)
	@echo "$(COLOR_YELLOW)Using Let's Encrypt STAGING environment$(COLOR_RESET)"
	@echo "$(COLOR_YELLOW)Certificates will not be trusted by browsers$(COLOR_RESET)"
	bash scripts/deploy.sh $(ENV)

deploy-production: ## Deploy to VPS (PRODUCTION certificates - LIMITED RATE LIMIT)
	@echo "$(COLOR_BOLD)⚠️  WARNING: PRODUCTION CERTIFICATES ⚠️$(COLOR_RESET)"
	@echo "$(COLOR_YELLOW)This will use Let's Encrypt production API$(COLOR_RESET)"
	@echo "$(COLOR_YELLOW)Rate limits apply: 5 failures/hour, 50 certs/week$(COLOR_RESET)"
	@read -p "Are you sure? (yes/no): " confirm && [ "$$confirm" = "yes" ]
	ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory bash scripts/deploy.sh $(ENV)

deploy-infra: ## Deploy infrastructure (Traefik, dns-manager, Portainer)
	@echo "$(COLOR_YELLOW)Deploying infrastructure services...$(COLOR_RESET)"
	bash scripts/deploy-infra.sh $(ENV)

deploy-infra-production: ## Deploy infrastructure with PRODUCTION certificates
	@echo "$(COLOR_BOLD)⚠️  WARNING: PRODUCTION CERTIFICATES ⚠️$(COLOR_RESET)"
	@read -p "Are you sure? (yes/no): " confirm && [ "$$confirm" = "yes" ]
	ACME_CA_SERVER=https://acme-v02.api.letsencrypt.org/directory bash scripts/deploy-infra.sh $(ENV)

deploy-auth: ## Deploy auth service (with PostgreSQL)
	@echo "$(COLOR_YELLOW)Deploying auth service...$(COLOR_RESET)"
	bash scripts/deploy-auth.sh $(ENV)

deploy-api: ## Deploy API service
	@echo "$(COLOR_YELLOW)Deploying API service...$(COLOR_RESET)"
	bash scripts/deploy-api.sh $(ENV)

deploy-ai: ## Deploy AI service
	@echo "$(COLOR_YELLOW)Deploying AI service...$(COLOR_RESET)"
	bash scripts/deploy-ai.sh $(ENV)

deploy-mcp: ## Deploy MCP service
	@echo "$(COLOR_YELLOW)Deploying MCP service...$(COLOR_RESET)"
	bash scripts/deploy-mcp.sh $(ENV)

deploy-all: ## Deploy all application services (NOT infrastructure)
	@echo "$(COLOR_YELLOW)Deploying all application services...$(COLOR_RESET)"
	bash scripts/deploy-all.sh $(ENV)

# ============================================================================
# Monitoring & Maintenance
# ============================================================================

health: ## Check service health
	@echo "$(COLOR_BOLD)Checking service health...$(COLOR_RESET)"
	bash scripts/health-check.sh

logs: ## Show logs for all services
	docker compose -f $(COMPOSE_FILE) logs -f

logs-api: ## Show API service logs
	docker logs -f api

logs-ai: ## Show AI service logs
	docker logs -f ai

logs-mcp: ## Show MCP service logs
	docker logs -f mcp

logs-auth: ## Show Auth service logs
	docker logs -f auth

logs-traefik: ## Show Traefik logs
	docker logs -f traefik

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
	@bash scripts/dns-manager.sh get-records

dns-sync: ## Sync DNS A records to current VPS_IP
	@bash scripts/dns-manager.sh sync-vps-dns

dns-snapshots: ## List DNS backup snapshots
	@bash scripts/dns-manager.sh list-snapshots

dns-restore: ## Restore DNS from snapshot (usage: make dns-restore SNAPSHOT_ID=123)
	@bash scripts/dns-manager.sh restore-snapshot $(SNAPSHOT_ID)

dns-verify: ## Verify DNS propagation
	@bash scripts/dns-manager.sh verify-dns

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

restart-api: ## Restart API service
	docker compose -f $(COMPOSE_FILE) restart api

restart-ai: ## Restart AI service
	docker compose -f $(COMPOSE_FILE) restart ai

restart-mcp: ## Restart MCP service
	docker compose -f $(COMPOSE_FILE) restart mcp

restart-auth: ## Restart Auth service
	docker compose -f $(COMPOSE_FILE) restart auth

restart-traefik: ## Restart Traefik
	docker compose -f $(COMPOSE_FILE) restart traefik

pull: ## Pull latest images
	docker compose -f $(COMPOSE_FILE) pull

exec-api: ## Execute shell in API container
	docker compose -f $(COMPOSE_FILE) exec api sh

exec-ai: ## Execute shell in AI container
	docker compose -f $(COMPOSE_FILE) exec ai sh

exec-auth: ## Execute shell in Auth container
	docker compose -f $(COMPOSE_FILE) exec auth sh

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
	bash scripts/backup.sh
