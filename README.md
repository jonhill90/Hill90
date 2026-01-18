# Hill90

Production-ready Docker-based microservices platform hosted on Hostinger VPS.

## Architecture

- **VPS**: AlmaLinux 10 on Hostinger
- **Runtime**: Docker Engine + Docker Compose
- **Edge Proxy**: Traefik with Let's Encrypt TLS
- **Languages**:
  - Python (FastAPI) for AI and MCP services
  - TypeScript (Express) for API, Auth, and UI services
- **Secrets**: SOPS + age encryption
- **Admin Access**: Twingate Zero Trust + SSH key authentication
- **Infrastructure**: Terraform (Hostinger VPS + Twingate)
- **Configuration**: Ansible playbooks
- **CI/CD**: GitHub Actions

## Services

| Service | Language | URL | Description |
|---------|----------|-----|-------------|
| API | TypeScript | https://api.hill90.com | API Gateway |
| AI | Python | https://ai.hill90.com | LangChain/LangGraph agents |
| MCP | Python | https://ai.hill90.com/mcp | MCP Gateway (authenticated) |
| Auth | TypeScript | Internal | JWT authentication |
| UI | TypeScript | https://hill90.com | Frontend |

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) (>= 1.6)
- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (>= 2.15)
- [SOPS](https://github.com/getsops/sops) (>= 3.8)
- [age](https://github.com/FiloSottile/age) (>= 1.1)
- [Docker](https://docs.docker.com/get-docker/) (>= 24.0) - for local development
- [Node.js](https://nodejs.org/) (>= 20) - for TypeScript services
- [Python](https://www.python.org/) (>= 3.12) - for Python services
- [Poetry](https://python-poetry.org/) - Python dependency management

## Quick Start

### 1. Clone Repository

```bash
git clone <repository-url>
cd Hill90
```

### 2. Install Dependencies

```bash
# macOS
brew install terraform ansible sops age

# Linux
# See individual tool documentation for installation
```

### 3. Initialize Secrets

```bash
make secrets-init
```

This will generate age keypair and create initial encrypted secrets file.

### 4. Provision VPS

```bash
cd infra/terraform
terraform init
terraform plan
terraform apply
```

### 5. Bootstrap VPS

```bash
make bootstrap
```

This will:
- Create deploy user with SSH keys
- Install Docker and Docker Compose
- Configure firewall (HTTP/HTTPS public, SSH from Twingate only)
- Harden SSH configuration
- Install SOPS and age for secrets management
- Install git and clone repository
- Transfer age encryption key from local machine

### 6. Deploy Services

```bash
make deploy
```

### 7. Verify Deployment

```bash
make health
```

## Development

### Local Development

Each service can be run locally for development:

```bash
# API Service (TypeScript)
cd src/services/api
npm install
npm run dev

# AI Service (Python)
cd src/services/ai
poetry install
poetry run uvicorn app.main:app --reload
```

### Building Services

```bash
make build
```

### Running Tests

```bash
make test
```

### Viewing Logs

```bash
# All services
make logs

# Specific service
make logs-api
make logs-ai
```

## Makefile Commands

| Command | Description |
|---------|-------------|
| `make help` | Show all available commands |
| `make build` | Build all Docker images |
| `make deploy` | Deploy to VPS |
| `make test` | Run all tests |
| `make lint` | Lint all code |
| `make format` | Format all code |
| `make logs` | Show logs for all services |
| `make logs-api` | Show API service logs |
| `make logs-ai` | Show AI service logs |
| `make health` | Check service health |
| `make ssh` | SSH into VPS |
| `make secrets-edit` | Edit encrypted secrets |
| `make secrets-init` | Initialize SOPS keys |
| `make bootstrap` | Bootstrap VPS infrastructure |
| `make twingate-setup` | Setup Twingate infrastructure |
| `make snapshot` | Create VPS snapshot |
| `make rebuild` | Rebuild VPS from scratch (DESTRUCTIVE) |
| `make rebuild-bootstrap` | Bootstrap VPS after rebuild |
| `make rebuild-complete` | Complete post-rebuild deployment |
| `make clean` | Clean up Docker resources |
| `make ps` | Show running containers |
| `make restart` | Restart all services |

## Secrets Management

Secrets are encrypted using SOPS with age encryption.

### Editing Secrets

```bash
make secrets-edit ENV=prod
```

### Secrets Structure

```bash
infra/secrets/
├── .sops.yaml              # SOPS configuration
├── prod.enc.env            # Encrypted production secrets
├── dev.enc.env             # Encrypted dev secrets
└── keys/
    ├── age-prod.key        # Production age private key (gitignored)
    └── age-prod.pub        # Production age public key
```

**Important**: Never commit decrypted secrets (*.dec.env) or private keys (*.key).

## CI/CD

Deployments are automated via GitHub Actions on push to `main` branch.

### GitHub Secrets Required

- `VPS_HOST`: VPS IP address or hostname
- `VPS_SSH_KEY`: Deploy user SSH private key
- `AGE_SECRET_KEY`: age private key for decryption

**Note:** CI/CD requires Twingate connection for VPS access

### Manual Deployment

```bash
make deploy
```

## Monitoring

### Health Checks

```bash
# Check all services
make health

# Manual checks
curl https://api.hill90.com/health
curl https://ai.hill90.com/health
```

### Traefik Dashboard

Access at https://traefik.hill90.com (requires authentication).

### Logs

```bash
# Stream all logs
make logs

# Service-specific logs
docker logs -f api
docker logs -f ai
docker logs -f mcp
```

## Security

### SSH Access

- Root login disabled
- Password authentication disabled
- Key-based authentication only
- Fail2ban enabled

### Network Security

- Firewall configured (HTTP/HTTPS public, SSH via Twingate only)
- Internal Docker network isolated from external access
- Twingate Zero Trust for secure admin access to VPS and internal services
- SSH access restricted to Docker networks (Twingate connector)

### Application Security

- MCP gateway requires JWT authentication
- Service-to-service authentication via shared secrets
- TLS certificates automatically renewed via Let's Encrypt
- Security headers enforced via Traefik

## Troubleshooting

### VPS Not Accessible

```bash
# Check VPS status via Hostinger MCP tools
# (See CLAUDE.md for MCP tool usage)

# Verify Twingate connection
# Check Twingate client shows connector online

# Test SSH via Twingate
ssh -i ~/.ssh/remote.hill90.com deploy@172.18.0.1
```

### Service Not Starting

```bash
# Check service logs
docker logs <service-name>

# Check Docker Compose status
docker compose -f deployments/compose/prod/docker-compose.yml ps

# Restart service
docker compose -f deployments/compose/prod/docker-compose.yml restart <service-name>
```

### TLS Certificate Issues

```bash
# Check Traefik logs
docker logs traefik

# Verify DNS records
dig api.hill90.com
dig ai.hill90.com

# Check certificate
openssl s_client -connect api.hill90.com:443 -showcerts
```

### Secrets Decryption Fails

```bash
# Verify age key exists
ls -la infra/secrets/keys/

# Check SOPS configuration
cat infra/secrets/.sops.yaml

# Test decryption
sops -d infra/secrets/prod.enc.env
```

## Documentation

- **[Claude Code Operating Manual](CLAUDE.md)** - How Claude Code manages this infrastructure
- **[Twingate Access Guide](docs/TWINGATE_ACCESS.md)** - Secure admin access via Twingate
- **[VPS Rebuild Runbook](docs/runbooks/vps-rebuild.md)** - Complete VPS rebuild automation
- [Bootstrap Runbook](docs/runbooks/bootstrap.md)
- [Deployment Runbook](docs/runbooks/deployment.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Security](docs/architecture/security.md)
- [Local Development](docs/development/local-setup.md)

## VPS Rebuild

For catastrophic failures or OS reinstalls:

```bash
# Automated rebuild workflow (executed by Claude Code)
make rebuild-full              # Create snapshot + rebuild OS
make rebuild-bootstrap VPS_IP=<new_ip>  # Bootstrap + deploy
make health                    # Verify deployment
```

See [VPS Rebuild Runbook](docs/runbooks/vps-rebuild.md) for complete details.

## License

MIT
