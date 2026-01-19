# Cleanup & Staging Plan

## 1. Break Bootstrap Into Stages

### Current State
- Single monolithic `bootstrap-v2.yml` playbook (~486 lines)
- If any stage fails, hard to debug/retry specific parts
- All-or-nothing approach

### Proposed Stages

#### Stage 1: System Preparation (`stage1-system.yml`)
- Install core utilities (jq, tmux, vim, wget, tar)
- Create deploy user
- Setup SSH keys
- Configure sudo
- Create application directories

#### Stage 2: Network & Security (`stage2-security.yml`)
- Install and configure firewalld
- Install Tailscale
- Join Tailscale network
- Lock SSH to Tailscale network only
- Configure SSH hardening
- Install fail2ban (optional)

#### Stage 3: Development Tools (`stage3-tools.yml`)
- Install Docker
- Add deploy user to docker group
- Install SOPS
- Install age tools

#### Stage 4: Application Setup (`stage4-app.yml`)
- Clone repository
- Setup secrets (age key transfer)
- Verify installations

### Benefits
- Can re-run specific stages if they fail
- Easier debugging (smaller, focused playbooks)
- Can skip stages that already completed
- Clearer logging per stage
- Aligns with phased approach in plan

## 2. Makefile Cleanup

### Commands to Keep (New API-based workflow)
```makefile
recreate-vps          # Tailscale key rotation + VPS rebuild via API
config-vps            # Ansible bootstrap (all stages)
config-vps-stage1     # System preparation only
config-vps-stage2     # Network & security only
config-vps-stage3     # Development tools only
config-vps-stage4     # Application setup only
snapshot              # VPS snapshot
```

### Commands to Deprecate (Old workflows)
```makefile
rebuild               # Old MCP-based rebuild
rebuild-bootstrap     # Replaced by config-vps
rebuild-full          # Replaced by recreate-vps + config-vps
rebuild-full-auto     # Replaced by recreate-vps
rebuild-full-auto-post-mcp  # Replaced by config-vps
rebuild-optimized     # Replaced by recreate-vps
rebuild-optimized-post-mcp  # Replaced by config-vps
rebuild-complete      # Replaced by config-vps
bootstrap             # Replaced by config-vps
```

### New Makefile Structure
```makefile
# ============================================================================
# Infrastructure Setup (Rare)
# ============================================================================
tailscale-setup       # Setup Tailscale (use API, deprecate Terraform)
secrets-init
secrets-edit
secrets-view
secrets-update

# ============================================================================
# VPS Rebuild (DESTRUCTIVE)
# ============================================================================
snapshot              # Create VPS snapshot
recreate-vps          # Rebuild VPS (auto-rotates Tailscale key)
config-vps            # Configure VPS (all stages)
config-vps-stage1     # System preparation
config-vps-stage2     # Network & security
config-vps-stage3     # Development tools
config-vps-stage4     # Application setup

# ============================================================================
# Deployment
# ============================================================================
deploy
deploy-production
health
logs
ps

# ============================================================================
# Development
# ============================================================================
dev
dev-logs
dev-down
test
lint
format
validate

# ============================================================================
# Service Management
# ============================================================================
up
down
restart
restart-<service>
pull
exec-<service>
clean

# ============================================================================
# Utilities
# ============================================================================
ssh
backup
```

## 3. Reference Documentation Updates

### vps-operations.md
- Remove all old rebuild workflows
- Document only: `recreate-vps` and `config-vps`
- Add staged bootstrap documentation
- Update with actual timings from test (135s rebuild, ~5min bootstrap)

### tailscale.md
- Remove Terraform references (now using API)
- Document `tailscale-setup` uses API directly

### deployment.md
- Keep as-is (still accurate)

### github-actions.md
- Update to reflect API-based approach
- Remove MCP references for automated workflows

### secrets.md
- Keep as-is (still accurate)

### task-management.md
- Keep as-is (still accurate)

## 4. Implementation Order

1. **Create staged Ansible playbooks** (4 separate files)
2. **Create master playbook** that includes all stages
3. **Update Makefile** with stage-specific targets
4. **Test each stage independently**
5. **Update CLAUDE.md** with new commands
6. **Update vps-operations.md** with staged approach
7. **Update tailscale.md** (remove Terraform)
8. **Update github-actions.md** (API-based)
9. **Remove deprecated Makefile targets** (or mark as deprecated)
10. **Commit and test full workflow**

## 5. Success Criteria

- ✅ Can run `make config-vps` to configure entire VPS
- ✅ Can run `make config-vps-stage2` to re-run only security stage
- ✅ Makefile has clear, non-overlapping commands
- ✅ Documentation reflects actual workflows
- ✅ Old/deprecated commands are removed
- ✅ Test rebuild workflow end-to-end
