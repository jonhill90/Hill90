# Twingate Terraform Configuration

This Terraform configuration manages the Twingate infrastructure for secure admin access to Hill90 VPS services.

## Overview

Creates:
- **Remote Network**: `hill90-vps` - logical network for VPS
- **Connector**: `hill90-vps-connector` - deployed as Docker container
- **Resources**: Internal services accessible via Twingate
  - PostgreSQL (postgres:5432)
  - Auth Service (auth:3001)
  - API Service (api:3000)
  - AI Service (ai:8000)
  - MCP Service (mcp:8001)

## Prerequisites

1. **Twingate Account**: Create account at [twingate.com](https://www.twingate.com)
2. **Twingate Network**: Set up network (e.g., `hill90.twingate.com`)
3. **API Key**: Generate from Twingate Admin Console → Settings → API

## Setup

### 1. Configure Variables

```bash
cd infra/terraform/twingate
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:
```hcl
twingate_api_key = "your-api-key-here"
twingate_network = "hill90.twingate.com"
```

### 2. Apply Configuration

```bash
# From project root
make twingate-apply
```

Or manually:
```bash
cd infra/terraform/twingate
terraform init
terraform apply
```

### 3. Inject Tokens into SOPS Secrets

The connector tokens need to be injected into encrypted secrets:

```bash
# From project root
make twingate-setup
```

This will:
1. Apply Terraform configuration
2. Extract connector tokens from Terraform output
3. Inject tokens into `infra/secrets/prod.enc.env`
4. Re-encrypt secrets with SOPS

## Usage

### Initial Setup
```bash
make twingate-setup
```

### Update Resources
After modifying `main.tf`:
```bash
cd infra/terraform/twingate
terraform apply
```

### Regenerate Tokens
If tokens are compromised:
```bash
cd infra/terraform/twingate
terraform taint twingate_connector_tokens.hill90_tokens
terraform apply
make twingate-setup  # Re-inject new tokens
```

### View Outputs
```bash
cd infra/terraform/twingate
terraform output network_name
terraform output -raw access_token  # Sensitive
```

## Integration with VPS Rebuild

During VPS rebuild workflow:

1. **First Time**: Run `make twingate-setup` to create infrastructure
2. **Subsequent Rebuilds**: Tokens persist, no Twingate changes needed
3. **If connector needs recreation**: Re-run `make twingate-setup`

The rebuild workflow (`make rebuild-full`) reminds you to run `twingate-setup` if needed.

## Resources

### Remote Network
Logical network containing the VPS and its services.

### Connector
Deployed as Docker container via `docker-compose.yml`. The connector:
- Runs in both `edge` and `internal` networks
- Uses tokens from Terraform output (via SOPS)
- Provides secure tunnel to Twingate network
- Auto-restarts on failure

### Twingate Resources
Each service is exposed as a Twingate resource. Users with access can connect to:
- `postgres` - Database admin (psql, pgAdmin)
- `auth` - Auth service debugging
- `api` / `ai` / `mcp` - Service debugging

## Security

- **API Key**: Never commit `terraform.tfvars` (in `.gitignore`)
- **Connector Tokens**: Stored encrypted in SOPS (`prod.enc.env`)
- **State File**: Local only (consider remote backend for team use)
- **Access Control**: Configure in Twingate Admin Console

## Troubleshooting

### Connector not connecting
```bash
docker logs twingate
# Check logs for token issues
```

### Tokens not injecting
```bash
# Verify Terraform outputs exist
cd infra/terraform/twingate
terraform output

# Manually run injection script
bash scripts/twingate-inject-tokens.sh
```

### Resources not accessible
1. Check connector status in Twingate Admin Console
2. Verify user has access to resources
3. Verify Twingate client is connected
4. Check service is running: `docker ps`

## Maintenance

### Adding a New Service
Edit `main.tf`:
```hcl
resource "twingate_resource" "new_service" {
  name              = "New Service"
  address           = "service-name"  # Docker container name
  remote_network_id = twingate_remote_network.hill90_vps.id
}
```

Then apply:
```bash
cd infra/terraform/twingate
terraform apply
```

### Destroying Everything
```bash
cd infra/terraform/twingate
terraform destroy
```

**Warning**: This will delete the connector and all resources. The Docker container will fail to connect.

## Architecture

```
User → Twingate Client → Twingate Cloud → Connector (Docker) → Internal Services
                                              ↓
                                        [edge network]
                                              ↓
                                        [internal network]
                                              ↓
                                    postgres / auth / api / ai / mcp
```

The connector bridges Twingate's cloud network with the VPS internal Docker network, providing secure zero-trust access without exposing services publicly.
