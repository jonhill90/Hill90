.PHONY: help build deploy test clean logs health ssh secrets-edit secrets-init bootstrap lint format ps restart snapshot rebuild rebuild-bootstrap rebuild-full tailscale-setup tailscale-rotate twingate-setup twingate-apply

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

help: ## Show this help message
	@echo "$(COLOR_BOLD)Hill90 VPS Management$(COLOR_RESET)"
	@echo ""
	@echo "$(COLOR_BLUE)Available commands:$(COLOR_RESET)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(COLOR_GREEN)%-20s$(COLOR_RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(COLOR_YELLOW)Environment:$(COLOR_RESET) $(ENV)"
	@echo "$(COLOR_YELLOW)Compose File:$(COLOR_RESET) $(COMPOSE_FILE)"

build: ## Build all Docker images
	@echo "$(COLOR_BOLD)Building all Docker images...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) build

deploy: ## Deploy to VPS
	@echo "$(COLOR_BOLD)Deploying to VPS...$(COLOR_RESET)"
	bash scripts/deploy.sh $(ENV)

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

health: ## Check service health
	@echo "$(COLOR_BOLD)Checking service health...$(COLOR_RESET)"
	bash scripts/health-check.sh

ssh: ## SSH into VPS
	@if [ -z "$(VPS_HOST)" ]; then \
		echo "$(COLOR_YELLOW)VPS_HOST not set. Please set it in $(ENV) secrets or pass VPS_HOST=<host>$(COLOR_RESET)"; \
		exit 1; \
	fi
	ssh deploy@$(VPS_HOST)

secrets-edit: ## Edit encrypted secrets
	@echo "$(COLOR_BOLD)Editing $(ENV) secrets...$(COLOR_RESET)"
	sops infra/secrets/$(ENV).enc.env

secrets-init: ## Initialize SOPS keys
	@echo "$(COLOR_BOLD)Initializing SOPS keys...$(COLOR_RESET)"
	bash scripts/secrets-init.sh

bootstrap: ## Bootstrap VPS infrastructure
	@echo "$(COLOR_BOLD)Bootstrapping VPS infrastructure...$(COLOR_RESET)"
	cd infra/ansible && ansible-playbook -i inventory/hosts.yml playbooks/bootstrap.yml

tailscale-setup: ## Setup Tailscale infrastructure (Terraform + secrets) - AUTOMATED
	@echo "$(COLOR_BOLD)Running automated Tailscale setup...$(COLOR_RESET)"
	bash scripts/tailscale-setup.sh

tailscale-rotate: tailscale-setup ## Rotate Tailscale auth key (generates new key and updates secrets)
	@echo "$(COLOR_GREEN)Tailscale auth key rotated!$(COLOR_RESET)"

twingate-apply: ## Apply Twingate Terraform configuration (deprecated - use Tailscale)
	@echo "$(COLOR_BOLD)Applying Twingate Terraform...$(COLOR_RESET)"
	cd infra/terraform/twingate && terraform init && terraform apply

twingate-setup: twingate-apply ## Setup Twingate and inject tokens into secrets (deprecated)
	@echo "$(COLOR_BOLD)Injecting Twingate tokens into secrets...$(COLOR_RESET)"
	bash scripts/twingate-inject-tokens.sh
	@echo "$(COLOR_GREEN)Twingate setup complete!$(COLOR_RESET)"

snapshot: ## Create VPS snapshot (safety backup)
	@echo "$(COLOR_BOLD)Creating VPS snapshot...$(COLOR_RESET)"
	bash scripts/vps-snapshot.sh

rebuild: ## Rebuild VPS from scratch (DESTRUCTIVE)
	@echo "$(COLOR_BOLD)WARNING: VPS REBUILD$(COLOR_RESET)"
	bash scripts/vps-rebuild.sh

rebuild-bootstrap: ## Bootstrap VPS after rebuild (requires VPS_IP and ROOT_PASSWORD)
	@echo "$(COLOR_BOLD)Bootstrapping rebuilt VPS...$(COLOR_RESET)"
	@if [ -z "$(VPS_IP)" ]; then \
		echo "$(COLOR_YELLOW)Error: VPS_IP is required$(COLOR_RESET)"; \
		echo "$(COLOR_YELLOW)Usage: make rebuild-bootstrap VPS_IP=<ip> ROOT_PASSWORD=<password>$(COLOR_RESET)"; \
		exit 1; \
	fi
	@if [ -z "$(ROOT_PASSWORD)" ]; then \
		if [ ! -f /tmp/hill90_root_password.txt ]; then \
			echo "$(COLOR_YELLOW)Error: ROOT_PASSWORD is required$(COLOR_RESET)"; \
			echo "$(COLOR_YELLOW)Usage: make rebuild-bootstrap VPS_IP=<ip> ROOT_PASSWORD=<password>$(COLOR_RESET)"; \
			echo "$(COLOR_YELLOW)Or create /tmp/hill90_root_password.txt with the password$(COLOR_RESET)"; \
			exit 1; \
		fi; \
	fi
	bash scripts/vps-bootstrap-from-rebuild.sh "$(ROOT_PASSWORD)" $(VPS_IP)

rebuild-full: snapshot rebuild ## Full rebuild workflow (automated via Claude Code)
	@echo "$(COLOR_BOLD)VPS rebuild initiated!$(COLOR_RESET)"
	@echo ""
	@echo "$(COLOR_YELLOW)NEXT STEPS (via Claude Code):$(COLOR_RESET)"
	@echo "  1. Ask Claude Code to rebuild VPS using MCP tools (see script output above)"
	@echo "  2. Wait for rebuild to complete (~5 minutes)"
	@echo "  3. Get new VPS IP from Claude Code"
	@echo "  4. Run: make rebuild-bootstrap VPS_IP=<new_ip>"
	@echo "  5. VPS will be fully deployed and ready!"
	@echo ""
	@echo "$(COLOR_GREEN)Automated steps:$(COLOR_RESET) snapshot → git install → repo clone → age key transfer → deploy → health check"
	@echo ""

rebuild-complete: rebuild-bootstrap deploy health ## Complete post-rebuild deployment
	@echo "$(COLOR_GREEN)VPS rebuild complete and healthy!$(COLOR_RESET)"
	@echo ""
	@echo "$(COLOR_YELLOW)REMINDER:$(COLOR_RESET)"
	@echo "  - Update DNS records if VPS IP changed"
	@echo "  - Verify Tailscale is connected"
	@echo "  - Public SSH is BLOCKED - use Tailscale for access"
	@echo ""

clean: ## Clean up Docker resources
	@echo "$(COLOR_BOLD)Cleaning up Docker resources...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) down
	docker system prune -f
	@echo "$(COLOR_GREEN)Cleanup complete!$(COLOR_RESET)"

ps: ## Show running containers
	docker compose -f $(COMPOSE_FILE) ps

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

up: ## Start all services
	docker compose -f $(COMPOSE_FILE) up -d

down: ## Stop all services
	docker compose -f $(COMPOSE_FILE) down

pull: ## Pull latest images
	docker compose -f $(COMPOSE_FILE) pull

exec-api: ## Execute shell in API container
	docker compose -f $(COMPOSE_FILE) exec api sh

exec-ai: ## Execute shell in AI container
	docker compose -f $(COMPOSE_FILE) exec ai sh

exec-auth: ## Execute shell in Auth container
	docker compose -f $(COMPOSE_FILE) exec auth sh

backup: ## Backup database and volumes
	@echo "$(COLOR_BOLD)Creating backup...$(COLOR_RESET)"
	bash scripts/backup.sh

validate: ## Validate configuration files
	@echo "$(COLOR_BOLD)Validating configuration...$(COLOR_RESET)"
	docker compose -f $(COMPOSE_FILE) config > /dev/null && echo "$(COLOR_GREEN)Docker Compose config valid$(COLOR_RESET)" || echo "$(COLOR_YELLOW)Docker Compose config invalid$(COLOR_RESET)"
	@echo "Checking Ansible playbooks..."
	cd infra/ansible && ansible-playbook --syntax-check playbooks/bootstrap.yml && echo "$(COLOR_GREEN)Ansible playbooks valid$(COLOR_RESET)" || echo "$(COLOR_YELLOW)Ansible playbooks invalid$(COLOR_RESET)"

dev: ## Run development environment
	docker compose -f deployments/compose/dev/docker-compose.yml up -d

dev-logs: ## Show development logs
	docker compose -f deployments/compose/dev/docker-compose.yml logs -f

dev-down: ## Stop development environment
	docker compose -f deployments/compose/dev/docker-compose.yml down
