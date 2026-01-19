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
- **Admin Access**: Tailscale VPN + SSH key authentication
- **Infrastructure**: Hostinger API + Tailscale API (fully automated)
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

- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html) (>= 2.15)
- [SOPS](https://github.com/getsops/sops) (>= 3.8)
- [age](https://github.com/FiloSottile/age) (>= 1.1)
- [Docker](https://docs.docker.com/get-docker/) (>= 24.0) - for local development
- [Node.js](https://nodejs.org/) (>= 20) - for TypeScript services
- [Python](https://www.python.org/) (>= 3.12) - for Python services
- [Poetry](https://python-poetry.org/) - Python dependency management
- [Tailscale](https://tailscale.com/download) - VPN for secure VPS access

## Quick Start

### 1. Clone Repository

```bash
git clone <repository-url>
cd Hill90
```

### 2. Install Dependencies

```bash
# macOS
brew install ansible sops age

# Linux
# See individual tool documentation for installation
```

### 3. Initialize Secrets

```bash
make secrets-init
```

This will generate age keypair and create initial encrypted secrets file.

### 4. Rebuild VPS (if needed)

**Complete VPS rebuild is fully automated with two options:**

#### Option A: Local Execution (Recommended)

```bash
# 1. Rebuild VPS (auto-waits, auto-retrieves IP, auto-updates secrets)
make recreate-vps

# 2. Bootstrap infrastructure (auto-extracts Tailscale IP, auto-updates secrets)
make config-vps VPS_IP=<ip>
```

**Time:** ~5-10 minutes

#### Option B: GitHub Actions

**Alternative method for remote execution or CI/CD integration.**

1. Go to repository → **Actions** → **VPS Recreate (Automated)**
2. Click **"Run workflow"**
3. Type **"RECREATE"** to confirm
4. Watch execution (~13 minutes)

**Time:** ~13 minutes (includes deployment)

**Status:** ✅ Tested successfully (Run #21128156365)

---

**Both options automatically:**
- Generate new Tailscale auth key via API
- Rebuild VPS OS via Hostinger API
- Create deploy user with SSH keys
- Install Docker and Docker Compose
- Configure firewall (HTTP/HTTPS public, SSH from Tailscale only)
- Join Tailscale network and capture IP
- Install SOPS and age for secrets management
- Clone repository and transfer encryption key

### 5. Deploy Services

```bash
make deploy
```

### 6. Verify Deployment

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

Run `make help` for a complete, organized list of commands. Key commands:

| Command | Description |
|---------|-------------|
| `make help` | Show all available commands (organized by section) |
| **Infrastructure Setup** | |
| `make tailscale-setup` | Setup Tailscale infrastructure (automated) |
| `make secrets-init` | Initialize SOPS keys |
| `make secrets-edit` | Edit encrypted secrets interactively |
| `make secrets-view KEY=<key>` | View specific secret value |
| `make secrets-update KEY=<key> VALUE=<val>` | Update secret value |
| **VPS Rebuild** | |
| `make snapshot` | Create VPS snapshot (safety backup) |
| `make recreate-vps` | Recreate VPS via API (DESTRUCTIVE) |
| `make config-vps VPS_IP=<ip>` | Configure VPS with Ansible |
| **Development** | |
| `make dev` | Run development environment |
| `make test` | Run all tests |
| `make lint` | Lint all code |
| `make format` | Format all code |
| `make validate` | Validate infrastructure configuration |
| **Deployment** | |
| `make build` | Build all Docker images |
| `make deploy` | Deploy to VPS (STAGING certificates) |
| `make deploy-production` | Deploy to VPS (PRODUCTION certificates) |
| **Monitoring** | |
| `make health` | Check service health |
| `make logs` | Show logs for all services |
| `make logs-api` | Show API service logs |
| `make logs-ai` | Show AI service logs |
| `make ssh` | SSH into VPS |
| **Service Management** | |
| `make ps` | Show running containers |
| `make restart` | Restart all services |
| `make restart-api` | Restart API service |
| `make clean` | Clean up Docker resources |

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

### GitHub Actions Workflows

**Two GitHub Actions workflows are available:**

1. **VPS Recreate Workflow** - `.github/workflows/recreate-vps.yml`
   - ✅ **Status:** Tested and operational (Run #21128156365)
   - **Trigger:** Manual via GitHub UI (type "RECREATE" to confirm)
   - **Duration:** ~13 minutes (recreate + bootstrap + deploy)
   - **Features:**
     - Full VPS rebuild via Hostinger API
     - Automatic bootstrap with Ansible
     - Service deployment via SSH over Tailscale
     - IP updates and secret management

2. **Tailscale ACL GitOps** - `.github/workflows/tailscale.yml`
   - ✅ **Status:** Operational
   - **Trigger:** Automatic on push to main (for `policy.hujson` changes)
   - **Features:**
     - Automatic ACL deployment to Tailscale network
     - ACL testing on pull requests
     - Full audit trail in git

### GitHub Secrets Required

To use GitHub Actions workflows, configure these secrets in repository settings:

- `HOSTINGER_API_KEY` - VPS management API access
- `TAILSCALE_API_KEY` - Tailscale device/auth key management
- `TS_OAUTH_CLIENT_ID` - GitHub runner network access (ephemeral nodes)
- `TS_OAUTH_SECRET` - GitHub runner network access (ephemeral nodes)
- `VPS_SSH_PRIVATE_KEY` - SSH access to VPS
- `SOPS_AGE_KEY` - Secrets decryption

**Full setup guide:** See `.claude/reference/github-actions.md`

### Manual Deployment

```bash
# Local deployment (recommended for development)
make deploy

# Or via SSH to VPS
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip> 'cd /opt/hill90/app && export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && bash scripts/deploy.sh prod'
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

- Firewall configured (HTTP/HTTPS public, SSH via Tailscale only)
- Internal Docker network isolated from external access
- Tailscale VPN for secure admin access to VPS
- SSH access restricted to Tailscale network (100.64.0.0/10)

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

# Verify Tailscale connection
tailscale status

# Test SSH via Tailscale
ssh -i ~/.ssh/remote.hill90.com deploy@100.99.139.10
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
- **[VPS Rebuild Runbook](docs/runbooks/vps-rebuild.md)** - Complete VPS rebuild automation
- [Bootstrap Runbook](docs/runbooks/bootstrap.md)
- [Deployment Runbook](docs/runbooks/deployment.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Security](docs/architecture/security.md)
- [Local Development](docs/development/local-setup.md)

## VPS Rebuild

For catastrophic failures or OS reinstalls, the VPS can be rebuilt in ~5-10 minutes:

```bash
# 1. Create safety snapshot (optional but recommended)
make snapshot

# 2. Rebuild VPS (auto-waits, auto-retrieves IP, auto-updates secrets)
make recreate-vps

# 3. Bootstrap infrastructure (auto-extracts Tailscale IP, auto-updates secrets)
make config-vps VPS_IP=<new_ip>

# 4. Deploy services
make deploy

# 5. Verify deployment
make health
```

**What happens automatically:**
- Tailscale auth key generation and rotation
- VPS OS rebuild via Hostinger API
- IP address retrieval and secret updates
- Complete infrastructure bootstrap (Docker, firewall, Tailscale, SOPS)
- Repository clone and encryption key transfer

See `.claude/reference/vps-operations.md` for complete details.

## License

MIT
