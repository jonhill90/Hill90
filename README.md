# Hill90

Production-ready Docker-based microservices platform hosted on Hostinger VPS.

## Architecture

- **VPS**: AlmaLinux 10 on Hostinger
- **Runtime**: Docker Engine + Docker Compose
- **Edge Proxy**: Traefik with Let's Encrypt TLS
  - **HTTP-01 Challenge**: For public services (api, ai, mcp)
  - **DNS-01 Challenge**: For Tailscale-only services (traefik, portainer)
- **Languages**:
  - Python (FastAPI) for AI and MCP services
  - TypeScript (Express) for API, Auth, and UI services
- **Secrets**: SOPS + age encryption
- **Admin Access**: Tailscale VPN + SSH key authentication
- **Infrastructure**: Hostinger API + Tailscale API (fully automated)
- **Configuration**: Ansible playbooks
- **CI/CD**: GitHub Actions
- **DNS**: Hostinger DNS API (automated via MCP tools)

## Services

| Service | Language | URL | Description |
|---------|----------|-----|-------------|
| Traefik | - | https://traefik.hill90.com | Edge proxy & load balancer |
| Portainer | - | https://portainer.hill90.com | Docker container management |
| DNS Manager | Python | Internal | DNS-01 challenge webhook for Let's Encrypt |
| API | TypeScript | https://api.hill90.com | API Gateway |
| AI | Python | https://ai.hill90.com | LangChain/LangGraph agents |
| MCP | Python | https://ai.hill90.com/mcp | MCP Gateway (authenticated) |
| Auth | TypeScript | Internal | JWT authentication |
| UI | TypeScript | https://hill90.com | Frontend |

**Note:** Traefik and Portainer are accessible only via Tailscale network (100.64.0.0/10).

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

**Complete VPS rebuild is fully automated with a 3-step process:**

#### Step 1: Rebuild VPS OS

```bash
make recreate-vps
```

**What happens:**
- Generates new Tailscale auth key via API
- Rebuilds VPS OS via Hostinger API (AlmaLinux 10)
- Waits for VPS to become available
- Retrieves new public IP
- Updates `VPS_IP` in encrypted secrets
- **Time:** ~3-5 minutes

#### Step 2: Bootstrap Infrastructure

```bash
make config-vps VPS_IP=<ip>
```

**What happens:**
- Creates deploy user with SSH keys
- Installs Docker and Docker Compose
- Configures firewall (HTTP/HTTPS public, SSH from Tailscale only)
- Joins Tailscale network and captures IP
- Installs SOPS and age for secrets management
- Clones repository and transfers encryption key
- Deploys Traefik + Portainer (infrastructure only)
- Updates DNS records automatically
- Updates `TAILSCALE_IP` in encrypted secrets
- **Time:** ~3-5 minutes

#### Step 3: Deploy Application Services

```bash
make deploy  # Staging certificates (safe for testing)
# OR
make deploy-production  # Production certificates (rate-limited!)
```

**What happens:**
- Deploys application services (api, ai, mcp, auth, ui)
- Requests Let's Encrypt certificates (staging or production)
- Verifies service health
- **Time:** ~2-3 minutes

---

**Total rebuild time:** ~8-13 minutes (3 steps)

**Why 3 steps?**
- **Infrastructure vs. Application**: Separating infrastructure (Traefik/Portainer) from application services prevents certificate exhaustion during VPS rebuild testing
- **Certificate Rate Limits**: Let's Encrypt limits failures to 5/hour. Testing rebuild multiple times would hit this limit if certificates were requested during bootstrap.
- **Flexibility**: Can rebuild infrastructure without redeploying applications

#### GitHub Actions Alternative

**For remote execution or CI/CD integration:**

1. Go to repository → **Actions** → **VPS Recreate (Automated)**
2. Click **"Run workflow"**
3. Type **"RECREATE"** to confirm
4. Watch execution (~10 minutes for Steps 1-2)
5. Manually trigger deployment workflow (Step 3)

**Status:** ✅ Tested successfully (Run #21128156365)

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
| **DNS Management** | |
| `make dns-view` | View current DNS records for hill90.com |
| `make dns-sync` | Sync DNS A records to current VPS_IP |
| `make dns-snapshots` | List DNS backup snapshots |
| `make dns-restore SNAPSHOT_ID=<id>` | Restore DNS from snapshot |
| `make dns-verify` | Verify DNS propagation |
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

**Four GitHub Actions workflows are available:**

1. **VPS Recreate Workflow** - `.github/workflows/recreate-vps.yml`
   - ✅ **Status:** Tested and operational (Run #21128156365)
   - **Trigger:** Manual via GitHub UI (type "RECREATE" to confirm)
   - **Duration:** ~3-5 minutes
   - **Features:**
     - Full VPS OS rebuild via Hostinger API
     - Automatic Tailscale auth key generation
     - VPS IP retrieval and secret updates
     - Auto-triggers config-vps workflow

2. **Config VPS Workflow** - `.github/workflows/config-vps.yml`
   - ✅ **Status:** Operational
   - **Trigger:** Automatic after recreate-vps, or manual via GitHub UI
   - **Duration:** ~3-5 minutes
   - **Features:**
     - Infrastructure bootstrap via Ansible
     - Traefik + Portainer deployment
     - Tailscale IP extraction and secret updates
     - Automatic DNS record updates

3. **Deploy Workflow** - `.github/workflows/deploy.yml`
   - ✅ **Status:** Operational
   - **Trigger:** Automatic on push to main, or manual via GitHub UI
   - **Duration:** ~2-3 minutes
   - **Features:**
     - Application service deployment (api, ai, mcp, auth, ui)
     - Production Let's Encrypt certificates
     - Health check validation
     - Deploys via SSH over Tailscale

4. **Tailscale ACL GitOps** - `.github/workflows/tailscale.yml`
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

**Authentication:**
- Username: `admin`
- Password: Auto-generated during deployment (stored in password manager)
- Credentials file (`.htpasswd`) is automatically generated from `TRAEFIK_ADMIN_PASSWORD_HASH` secret
- Accessible only via Tailscale network (IP whitelist: 100.64.0.0/10)

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
  - HTTP-01 challenge for public services
  - DNS-01 challenge for Tailscale-only services
- Security headers enforced via Traefik
- Traefik dashboard authentication auto-generated from encrypted secrets
- Tailscale-only services protected by IP whitelist middleware (100.64.0.0/10)

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

### DNS-01 Certificate Issues

```bash
# Check dns-manager logs
ssh deploy@<tailscale-ip> 'docker logs dns-manager --tail 50'

# Verify DNS TXT records
dig TXT _acme-challenge.traefik.hill90.com @8.8.8.8

# Check Traefik logs for ACME errors
docker logs traefik | grep -i acme

# Common issues:
# 1. Wrong TXT value - dns-manager must compute base64url(SHA256(keyAuth))
# 2. Timeout during /present - Remove sleep() from dns-manager
# 3. Rate limiting - Wait 1 hour, use STAGING certificates for testing
```

### DNS Management Issues

```bash
# View current DNS records
make dns-view

# Verify DNS propagation
make dns-verify

# Check secrets are correct
make secrets-view KEY=VPS_IP
make secrets-view KEY=TAILSCALE_IP

# Manually sync DNS after VPS rebuild
make dns-sync
```

## Documentation

### Core Documentation
- **[Claude Code Operating Manual](CLAUDE.md)** - How Claude Code manages this infrastructure
- **[VPS Rebuild Runbook](docs/runbooks/vps-rebuild.md)** - Complete VPS rebuild automation

### Architecture
- [Architecture Overview](docs/architecture/overview.md)
- [Certificate Management](docs/architecture/certificates.md) - HTTP-01 vs DNS-01 challenges
- [Security](docs/architecture/security.md)

### Runbooks
- [Bootstrap Runbook](docs/runbooks/bootstrap.md)
- [Deployment Runbook](docs/runbooks/deployment.md)
- [Troubleshooting Guide](docs/runbooks/troubleshooting.md)

### Development
- [Local Development](docs/development/local-setup.md)

## VPS Rebuild

For catastrophic failures or OS reinstalls, the VPS can be rebuilt in ~8-13 minutes using a 3-step process:

```bash
# 1. Create safety snapshot (optional but recommended)
make snapshot

# 2. Rebuild VPS OS (auto-waits, auto-retrieves IP, auto-updates secrets)
make recreate-vps

# 3. Bootstrap infrastructure (auto-extracts Tailscale IP, auto-updates secrets, deploys Traefik + Portainer)
make config-vps VPS_IP=<new_ip>

# 4. Deploy application services (STAGING certificates - safe for testing)
make deploy

# OR for production certificates (rate-limited!)
make deploy-production

# 5. Verify deployment
make health
```

**What happens automatically:**

**Step 2 - Recreate VPS (~3-5 minutes):**
- Tailscale auth key generation via API
- VPS OS rebuild via Hostinger API
- IP address retrieval and secret updates

**Step 3 - Bootstrap Infrastructure (~3-5 minutes):**
- Deploy user creation with SSH keys
- Docker and Docker Compose installation
- Firewall configuration (HTTP/HTTPS public, SSH from Tailscale only)
- Tailscale network join and IP capture
- SOPS and age installation
- Repository clone and encryption key transfer
- Traefik + Portainer deployment (infrastructure only)
- DNS record updates

**Step 4 - Deploy Services (~2-3 minutes):**
- Application service deployment (api, ai, mcp, auth, ui)
- Let's Encrypt certificate acquisition (staging or production)
- Service health verification

**Why 3 steps?** Separating infrastructure from application deployment prevents Let's Encrypt rate limit exhaustion during VPS rebuild testing.

See `.claude/reference/vps-operations.md` for complete details.

## License

MIT
