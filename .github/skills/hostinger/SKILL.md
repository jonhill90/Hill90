---
name: hostinger
description: Manage Hostinger VPS and DNS via CLI. Use for VPS rebuild, start/stop/restart, snapshots, DNS records, DNS sync, DNS verification, and all infrastructure operations on hill90.com.
---

# Hostinger CLI

Manage VPS and DNS for hill90.com using `scripts/hostinger.sh`.

**CLI:** `bash scripts/hostinger.sh <service> <command> [args]`

## CLI Structure

```
hostinger.sh vps      get | start | stop | restart | recreate | snapshot | action | actions | metrics | scripts
hostinger.sh dns      get | update | validate | delete | reset | sync | verify | snapshot
```

## VPS Commands

### Get Details

```bash
bash scripts/hostinger.sh vps get
```

### Lifecycle

```bash
bash scripts/hostinger.sh vps start
bash scripts/hostinger.sh vps stop
bash scripts/hostinger.sh vps restart
```

### Recreate (DESTRUCTIVE)

```bash
# Rebuilds OS — destroys all data
bash scripts/hostinger.sh vps recreate 1183 'password'
bash scripts/hostinger.sh vps recreate 1183 'password' 2395  # with post-install script
```

### Snapshots

```bash
bash scripts/hostinger.sh vps snapshot create   # overwrites existing
bash scripts/hostinger.sh vps snapshot get
bash scripts/hostinger.sh vps snapshot restore
```

### Actions

```bash
bash scripts/hostinger.sh vps actions                      # list recent
bash scripts/hostinger.sh vps action get <action_id>       # check status
bash scripts/hostinger.sh vps action wait <action_id>      # poll until done
bash scripts/hostinger.sh vps action wait <action_id> 300  # custom timeout
```

### Monitoring

```bash
bash scripts/hostinger.sh vps metrics
bash scripts/hostinger.sh vps scripts    # list post-install scripts
```

## DNS Commands

### View Records

```bash
bash scripts/hostinger.sh dns get
```

### Update Records

```bash
# From JSON file
bash scripts/hostinger.sh dns update records.json

# Inline JSON
bash scripts/hostinger.sh dns update '{"overwrite":true,"zone":[{"name":"@","type":"A","ttl":3600,"records":[{"content":"1.2.3.4"}]}]}'
```

### Validate Before Applying

```bash
bash scripts/hostinger.sh dns validate records.json
```

### Delete Record

```bash
bash scripts/hostinger.sh dns delete www A
```

### Sync A Records to VPS IP

```bash
# Reads VPS_IP and TAILSCALE_IP from secrets, checks idempotency, validates, applies
bash scripts/hostinger.sh dns sync
```

### Verify Propagation

```bash
bash scripts/hostinger.sh dns verify
```

### DNS Snapshots

```bash
bash scripts/hostinger.sh dns snapshot list
bash scripts/hostinger.sh dns snapshot get <snapshot_id>
bash scripts/hostinger.sh dns snapshot restore <snapshot_id>
```

### Reset (DESTRUCTIVE)

```bash
bash scripts/hostinger.sh dns reset   # resets ALL records to defaults
```

## Common Workflows

### Full VPS Rebuild (4 Steps)

```bash
make recreate-vps                    # 1. Rebuild OS (auto-rotates keys, auto-gets IP)
make config-vps VPS_IP=<ip>          # 2. Bootstrap OS (Ansible)
make deploy-infra                    # 3. Deploy Traefik, Portainer
make deploy-all                      # 4. Deploy app services
```

### DNS Sync After Rebuild

```bash
bash scripts/hostinger.sh dns sync     # idempotent — skips if already correct
bash scripts/hostinger.sh dns verify   # check propagation
```

### Safety Snapshot Before Changes

```bash
bash scripts/hostinger.sh vps snapshot create
# ... make changes ...
bash scripts/hostinger.sh vps snapshot restore  # rollback if needed
```

## Make Targets

| Target | Runs |
|--------|------|
| `make snapshot` | `hostinger.sh vps snapshot create` |
| `make dns-view` | `hostinger.sh dns get` |
| `make dns-sync` | `hostinger.sh dns sync` |
| `make dns-verify` | `hostinger.sh dns verify` |
| `make dns-snapshots` | `hostinger.sh dns snapshot list` |
| `make dns-restore SNAPSHOT_ID=123` | `hostinger.sh dns snapshot restore 123` |

## Constants

| Key | Value |
|-----|-------|
| VPS ID | 1264324 |
| Template | 1183 (AlmaLinux 10) |
| Domain | hill90.com |
| Tailscale IP | 100.108.199.106 |
| API Base | https://developers.hostinger.com |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOSTINGER_API_KEY` | from secrets | API key (auto-loaded from SOPS) |
| `HOSTINGER_VPS_ID` | 1264324 | VPS instance ID |
| `HOSTINGER_DOMAIN` | hill90.com | Domain for DNS operations |
