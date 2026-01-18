# Hill90 Automation TODO

## Bootstrap Automation Gaps

These manual steps were required during VPS rebuild and need to be automated:

### 1. Git Installation
**Current State:** Manual install via `sudo dnf install -y git`
**Required Action:** Add git to Ansible bootstrap playbook
**File:** `infra/ansible/playbooks/bootstrap.yml`
**Priority:** HIGH

```yaml
# Add to bootstrap.yml before repository clone
- name: Install git
  dnf:
    name: git
    state: present
```

### 2. Repository Clone
**Current State:** Manual clone after bootstrap
**Required Action:** Automate repository cloning in Ansible
**File:** `infra/ansible/playbooks/bootstrap.yml`
**Priority:** HIGH

```yaml
- name: Clone Hill90 repository
  git:
    repo: "{{ app_repo }}"
    dest: "{{ app_directory }}/app"
    version: "{{ app_branch }}"
  become_user: "{{ deploy_user }}"
```

### 3. Age Key Distribution
**Current State:** Manual SCP of age key to VPS
**Required Action:** Document secure key distribution method
**Options:**
- Option A: Generate key on VPS during bootstrap (most secure)
- Option B: Encrypt key in Terraform outputs
- Option C: Manual distribution during initial setup only
**Priority:** MEDIUM

**Recommendation:** Generate age key on VPS, then:
1. Print public key for user to add to `.sops.yaml`
2. User re-encrypts secrets with new public key
3. Deploy with newly encrypted secrets

### 4. Firewall Configuration for Twingate
**Current State:** SSH service still publicly accessible
**Required Action:** Configure firewall to allow SSH only from Twingate connector
**File:** `infra/ansible/playbooks/03-firewall.yml`
**Priority:** HIGH

Need to determine correct approach:
- Allow SSH from localhost only?
- Allow SSH from Docker bridge networks?
- Use Twingate connector to proxy SSH connections?

### 5. Twingate Connector Network Architecture
**Current State:** Connector can't route to host SSH via Docker gateway
**Issue:** Docker bridge networking prevents connector from accessing host SSH
**Priority:** CRITICAL

**Possible Solutions:**
1. Use host networking for Twingate connector (`network_mode: host`)
2. Configure firewall to allow SSH from Docker networks
3. Use Twingate's built-in SSH proxy feature

### 6. DNS Configuration
**Current State:** Manual DNS record creation
**Required Action:** Add DNS verification to health checks
**File:** `scripts/health-check.sh`
**Priority:** LOW
**Note:** Already implemented in health-check.sh, just needs secrets access

### 7. Secrets Management in CI/CD
**Current State:** Age key manually copied to VPS
**Required Action:** Document secure secrets deployment workflow
**Priority:** MEDIUM

**Workflow:**
1. Generate age key on VPS
2. Encrypt secrets locally with VPS public key
3. Commit encrypted secrets to repo
4. Deploy script decrypts on VPS using local private key

## VPS Rebuild Automation

### Current rebuild process:
1. ✅ Snapshot VPS via MCP
2. ✅ Rebuild OS via MCP `recreateVirtualMachineV1`
3. ✅ Remove old SSH host key
4. ✅ Bootstrap with Ansible
5. ❌ **MANUAL:** Install git
6. ❌ **MANUAL:** Clone repository
7. ❌ **MANUAL:** Copy age key
8. ✅ Deploy services

### Target rebuild process (fully automated):
1. Snapshot VPS via MCP
2. Rebuild OS via MCP
3. Bootstrap with Ansible (includes git install + repo clone)
4. Copy age key (automated or pre-generated on VPS)
5. Deploy services
6. Verify health

## Twingate SSH Access TODO

### Current Status (2026-01-18):
- ✅ Twingate connector deployed and online (State: Online)
- ✅ VPS fully deployed with all services running
- ❌ **SSH still publicly accessible** - firewall has `ssh` service enabled
- ❌ **Twingate SSH routing NOT working** - tried multiple approaches

### Attempts Made:
1. **Docker gateway IP (172.18.0.1)** - Connection timeout (connector can't route to host via Docker bridge)
2. **VPS hostname (srv1264324.hstgr.cloud)** - Worked initially via public internet, then failed when SSH service removed
3. **localhost** - Connection refused (localhost doesn't route through Twingate)
4. **hill90-vps.internal** - Can't resolve from local machine (Twingate DNS issue)

### Current Blocker:
**Twingate resource hostname resolution failing**
- Created resource: `hill90-vps.internal`
- Added to VPS /etc/hosts: `127.0.0.1 hill90-vps.internal`
- Local machine can't resolve `hill90-vps.internal`
- Need to determine: Does Twingate provide DNS? Do I need to configure Twingate DNS on client?

### Questions to Resolve:
1. **How does Twingate DNS work?** - Does it automatically resolve resource addresses?
2. **Do I need to enable Twingate DNS on the client?** - Is there a DNS setting?
3. **Should I use a different address format?** - IP? FQDN? Special Twingate format?
4. **Can connector route to localhost SSH?** - Or does it need host networking mode?

### Required Actions:
1. **Research Twingate DNS resolution** - How do clients resolve resource addresses?
2. **Test Twingate client DNS settings** - Check if DNS needs to be enabled
3. **Alternative: Use host networking for connector** - `network_mode: host` in docker-compose
4. **Configure firewall** to block public SSH (only after Twingate verified working)
5. **Document Twingate SSH workflow** in `docs/TWINGATE_ACCESS.md` once working

### Firewall Strategy (PENDING DECISION):
```bash
# Option A: Allow SSH only from localhost (for connector on same host)
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="127.0.0.1" port port="22" protocol="tcp" accept'

# Option B: Allow SSH from Docker networks
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.17.0.0/16" port port="22" protocol="tcp" accept'
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.18.0.0/16" port port="22" protocol="tcp" accept'

# Option C: Use Twingate connector host networking
# Modify docker-compose.yml:
network_mode: host  # Instead of bridge networks
```

## Scripts to Create

### 1. `scripts/vps-rebuild.sh`
**Status:** Created but needs testing
**Purpose:** Automated VPS rebuild workflow
**Dependencies:**
- MCP tools for VPS operations
- Terraform for state management
- Ansible for bootstrap

### 2. `scripts/vps-bootstrap-from-rebuild.sh`
**Status:** Created but needs testing
**Purpose:** Post-rebuild bootstrap automation
**Current Gaps:**
- Doesn't install git
- Doesn't clone repository
- Doesn't handle age key

### 3. `scripts/twingate-inject-tokens.sh`
**Status:** ✅ Complete
**Purpose:** Inject Terraform-generated tokens into SOPS secrets

## Documentation Updates Needed

### 1. `docs/TWINGATE_ACCESS.md`
**Status:** ✅ Created
**Needs:** Update with tested SSH access method once verified

### 2. `docs/runbooks/vps-rebuild.md`
**Status:** ❌ Not created
**Needs:** Complete rebuild runbook with all manual steps documented

### 3. `README.md`
**Status:** ❌ Needs update
**Needs:**
- Remove Tailscale references
- Add Twingate setup instructions
- Document bootstrap process
- Document secrets management

## Priority Order

1. **HIGH:** Test Twingate SSH access (BLOCKING)
2. **HIGH:** Configure firewall for Twingate-only SSH (BLOCKING)
3. **HIGH:** Add git install to Ansible bootstrap
4. **HIGH:** Add repository clone to Ansible bootstrap
5. **MEDIUM:** Document age key distribution strategy
6. **MEDIUM:** Automate age key handling
7. **LOW:** Update README and documentation

## Testing Required

- [ ] Test Twingate SSH access from local machine
- [ ] Test VPS rebuild automation end-to-end
- [ ] Test firewall rules (verify public SSH blocked, Twingate works)
- [ ] Test deploy script after automated bootstrap
- [ ] Test health checks with DNS verification

## Known Issues

1. **Firewall still allows public SSH** - SSH service enabled in firewall despite port 22 removed
2. **Twingate SSH routing unclear** - Haven't tested if connector can route SSH connections
3. **Manual steps required** - Git install, repo clone, age key copy all manual
4. **Docker gateway routing** - Connector may not be able to reach host SSH via 172.18.0.1

## Questions to Resolve

1. Should Twingate connector use `network_mode: host` instead of bridge networking?
2. How should age keys be distributed securely?
3. Should we generate age keys on VPS instead of copying?
4. What firewall rules allow Twingate connector to access host SSH?
