# DNS Management for Hill90 VPS

This guide covers DNS management for the Hill90 VPS infrastructure using the Hostinger API via MCP tools.

## Overview

The Hill90 domain (hill90.com) uses DNS records to route traffic to the VPS and Tailscale network:

**Public Services (accessible via internet):**
- `hill90.com` (@) → 76.13.26.69 (VPS public IP)
- `api.hill90.com` → 76.13.26.69 (API service)
- `ai.hill90.com` → 76.13.26.69 (AI service)
- `www.hill90.com` → CNAME to hill90.com

**Tailscale-Only Services (accessible only on Tailscale network):**
- `portainer.hill90.com` → 100.78.82.89 (Tailscale IP)
- `traefik.hill90.com` → 100.78.82.89 (Tailscale IP)

**Other Records:**
- `remote.hill90.com` → 31.97.42.69 (Remote Mac server)
- `_minecraft._tcp.minecraft` → SRV record for Minecraft server
- CAA records → Let's Encrypt, DigiCert, GlobalSign, etc.

## Quick Reference

### View DNS Records

```bash
make dns-view
```

Or use Claude Code MCP tool directly:
```javascript
mcp__MCP_DOCKER__DNS_getDNSRecordsV1(domain="hill90.com")
```

### Sync DNS After VPS Recreate

After recreating the VPS, sync DNS records to the new VPS IP:

```bash
make dns-sync
```

This will:
1. Read VPS_IP from encrypted secrets
2. Display MCP commands to update DNS A records
3. Preserve non-A records (CNAME, CAA, SRV, etc.)

### Verify DNS Propagation

Check that DNS records have propagated:

```bash
make dns-verify
```

This uses `dig` to query DNS servers and verify the records match expected values.

### DNS Snapshots

Hostinger automatically creates DNS snapshots before updates. To list snapshots:

```bash
make dns-snapshots
```

To restore from a snapshot:

```bash
make dns-restore SNAPSHOT_ID=123
```

## DNS Record Structure

### A Records (Public Services)

```json
{
  "name": "@",
  "type": "A",
  "ttl": 3600,
  "records": [{"content": "76.13.26.69"}]
}
```

### A Records (Tailscale Services)

```json
{
  "name": "portainer",
  "type": "A",
  "ttl": 3600,
  "records": [{"content": "100.78.82.89"}]
}
```

### CNAME Records

```json
{
  "name": "www",
  "type": "CNAME",
  "ttl": 300,
  "records": [{"content": "hill90.com."}]
}
```

## Manual DNS Updates via MCP Tools

### Update A Records

1. **Load the DNS tools:**
   ```javascript
   ToolSearch query="select:mcp__MCP_DOCKER__DNS_updateDNSRecordsV1"
   ```

2. **Validate the update:**
   ```javascript
   mcp__MCP_DOCKER__DNS_validateDNSRecordsV1(
       domain="hill90.com",
       overwrite=true,
       zone=[
           {
               "name": "@",
               "type": "A",
               "ttl": 3600,
               "records": [{"content": "76.13.26.69"}]
           }
       ]
   )
   ```

3. **Apply the update:**
   ```javascript
   mcp__MCP_DOCKER__DNS_updateDNSRecordsV1(
       domain="hill90.com",
       overwrite=true,
       zone=[
           {
               "name": "@",
               "type": "A",
               "ttl": 3600,
               "records": [{"content": "76.13.26.69"}]
           }
       ]
   )
   ```

## VPS Recreate Workflow

When you recreate the VPS, follow this workflow:

1. **Recreate VPS:**
   ```bash
   make recreate-vps
   ```
   This automatically updates VPS_IP and TAILSCALE_IP in secrets.

2. **Bootstrap VPS:**
   ```bash
   make config-vps VPS_IP=<new-ip>
   ```
   This extracts and updates TAILSCALE_IP in secrets.

3. **Sync DNS records:**
   ```bash
   make dns-sync
   ```
   Use Claude Code to run the displayed MCP commands to update DNS.

4. **Verify DNS:**
   ```bash
   make dns-verify
   ```

5. **Wait for propagation:**
   DNS changes typically propagate in 5-10 minutes.

## Troubleshooting

### DNS Not Propagating

1. Check current DNS records:
   ```bash
   make dns-view
   ```

2. Verify secrets are correct:
   ```bash
   make secrets-view KEY=VPS_IP
   make secrets-view KEY=TAILSCALE_IP
   ```

3. Check DNS with dig:
   ```bash
   dig +short hill90.com
   dig +short portainer.hill90.com
   ```

4. Clear local DNS cache (Mac):
   ```bash
   sudo dscacheutil -flushcache
   sudo killall -HUP mDNSResponder
   ```

### CNAME vs A Record Conflicts

You cannot have both a CNAME and an A record for the same hostname. If you get a conflict error:

1. Check current records:
   ```bash
   make dns-view
   ```

2. Decide whether to use CNAME or A record
3. Update with `overwrite=true` to replace the record

Example: `www.hill90.com` is a CNAME to `hill90.com`, so it cannot also have an A record.

### Rate Limiting

The Hostinger API has rate limits. If you hit a rate limit:

1. Wait 5-10 minutes
2. Use `make dns-snapshots` to verify snapshots exist
3. Retry the operation

## DNS Template File

DNS A record templates are stored in `infra/dns/hill90.com.json`:

```json
{
  "records": [
    {
      "type": "A",
      "name": "@",
      "content": "${VPS_IP}",
      "ttl": 3600,
      "priority": null
    }
  ]
}
```

The `${VPS_IP}` variable is replaced with the value from `infra/secrets/prod.enc.env`.

## Security Notes

1. **MCP Tool Permissions:** DNS tools are enabled in `.claude/settings.local.json`
2. **API Key Protection:** `HOSTINGER_API_KEY` is SOPS-encrypted in secrets
3. **Snapshot Backups:** Hostinger creates automatic snapshots before DNS updates
4. **Validation:** Always validate DNS records before applying changes

## Reference

- **Script:** `scripts/dns-manager.sh`
- **Template:** `infra/dns/hill90.com.json`
- **Secrets:** `infra/secrets/prod.enc.env`
- **MCP Settings:** `.claude/settings.local.json`
