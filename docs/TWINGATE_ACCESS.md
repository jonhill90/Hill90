# Twingate Access Guide

## Overview

The Hill90 VPS uses **Twingate Zero Trust Network Access** for secure admin access. Public SSH is **completely blocked** - you must connect via Twingate tunnel.

## Architecture

```
Your Machine → Twingate Client → Twingate Cloud → Connector (VPS) → Resources
```

- **Connector**: Runs as Docker container on VPS
- **Resources**: VPS host SSH + internal services (postgres, auth, etc.)
- **Network**: `hill90.twingate.com`

## Setup Twingate Client

### 1. Install Twingate Client

**macOS:**
```bash
brew install --cask twingate
```

**Linux:**
```bash
curl -s https://binaries.twingate.com/client/linux/install.sh | sudo bash
```

**Windows:**
Download from: https://www.twingate.com/download

### 2. Configure Client

```bash
# Setup Twingate
twingate setup

# When prompted, enter:
# Network: hill90
```

This will open a browser for authentication.

### 3. Start Twingate

```bash
twingate start
```

Verify connection:
```bash
twingate status
# Should show: Connected to hill90 network
```

## Accessing the VPS

### SSH Access

Once connected to Twingate:

```bash
# SSH via Twingate tunnel
ssh -i ~/.ssh/remote.hill90.com deploy@172.18.0.1

# Or add to ~/.ssh/config:
Host hill90-vps
    HostName 172.18.0.1
    User deploy
    IdentityFile ~/.ssh/remote.hill90.com

# Then simply:
ssh hill90-vps
```

**Note:** The address `172.18.0.1` is the Docker gateway IP - the VPS host as seen from the Twingate connector.

### Available Resources

When connected to Twingate, you have access to:

| Resource | Address | Purpose |
|----------|---------|---------|
| **Hill90 VPS SSH** | 172.18.0.1:22 | SSH to VPS host |
| **PostgreSQL** | postgres:5432 | Database access |
| **Auth Service** | auth:3001 | Auth internal API |
| **API Service** | api:3000 | API internal debugging |
| **AI Service** | ai:8000 | AI internal debugging |
| **MCP Service** | mcp:8001 | MCP internal debugging |

### Accessing Internal Services

From your local machine (while connected to Twingate):

```bash
# Connect to PostgreSQL
psql -h postgres -U hill90 -d hill90

# Test internal API
curl http://auth:3001/health
curl http://api:3000/health
curl http://ai:8000/health
curl http://mcp:8001/health
```

## Troubleshooting

### Can't SSH to VPS

1. **Check Twingate status:**
   ```bash
   twingate status
   ```
   Should show: `Connected to hill90 network`

2. **Check resource access:**
   ```bash
   twingate resources
   ```
   Should list "Hill90 VPS SSH" with access granted

3. **Verify connector is online:**
   - Go to: https://hill90.twingate.com/
   - Navigate to: Networks → hill90-vps → Connectors
   - Status should be: **Online** (green)

4. **Check SSH key:**
   ```bash
   ls -la ~/.ssh/remote.hill90.com
   ```

### Connector Offline

If connector shows offline in Twingate console:

```bash
# SSH to VPS via Hostinger console recovery mode
# Then check connector:
docker logs twingate

# Restart if needed:
docker restart twingate
```

### Lost Access Completely

**Recovery via Hostinger Console:**

1. Log in to: https://hpanel.hostinger.com/
2. Navigate to: VPS → Hill90 VPS
3. Click: **Recovery Console**
4. This gives direct console access without SSH

**Alternative: Use Hostinger MCP tools to rebuild**

## Security Notes

- ✅ Public SSH is **completely blocked** via firewall
- ✅ VPS only exposes ports 80 (HTTP) and 443 (HTTPS) to internet
- ✅ All admin access requires Twingate authentication
- ✅ Connector tokens encrypted with SOPS/age
- ✅ Zero trust architecture - no VPN subnet routing

## Managing Access

### Grant Access to New User

1. Go to: https://hill90.twingate.com/
2. Navigate to: Users → Invite User
3. After user joins, grant access:
   - Go to: Resources
   - Select resource (e.g., "Hill90 VPS SSH")
   - Click: Add Users/Groups
   - Select user → Save

### Revoke Access

1. Go to: Resources → Select resource
2. Click on user → Remove
3. User loses access immediately

## Terraform Management

Twingate infrastructure is managed via Terraform:

```bash
cd infra/terraform/twingate

# View resources
terraform show

# Add new resource
# Edit main.tf, then:
terraform apply

# Destroy Twingate setup (careful!)
terraform destroy
```

## References

- Twingate Admin Console: https://hill90.twingate.com/
- Twingate Documentation: https://docs.twingate.com/
- Connector Logs: `docker logs twingate` (on VPS)
