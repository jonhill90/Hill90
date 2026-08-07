# VPS Rebuild Runbook

Complete automated rebuild of the Hill90 VPS from catastrophic failure.

## Overview

The host-level rebuild (VPS OS, Ansible bootstrap, Traefik/Portainer, observability)
is fully automated. **Vault is not** — initializing, configuring, seeding and
generating AppRole credentials for a freshly-deployed OpenBao are manual steps this
runbook does not itself walk through (see Step 7, h#807). The process takes
~8-13 minutes for the automated portion and consists of 6 automated steps,
plus manual vault setup and a final health check:

1. **Recreate VPS** (~3-5 minutes) - OS rebuild via Hostinger API
2. **Config VPS** (~3-5 minutes) - Infrastructure bootstrap via Ansible
3. **Deploy Infra** (~1-2 minutes) - Infrastructure service deployment (Traefik, Portainer)
4. **Deploy Database** (~1 minute) - PostgreSQL (h#831 — previously missing from this runbook entirely)
5. **Deploy Auth** (~1 minute) - Keycloak, after database (h#831 — previously missing)
6. **Deploy MinIO** (~1 minute) - Object storage, after auth (h#831 — previously missing)
7. **Deploy AND configure Vault** (manual — not on the automated clock) - see Step 7
8. **Deploy Observability** (~1 minute) - Monitoring stack
9. **Health Verification** - confirm every service, not just the ones deployed last

**h#831, stated plainly rather than softened: following this runbook's PRIOR
version end to end rebuilt a VPS with no database, no Keycloak and no object
storage.** `db` and `minio` were absent from the document entirely — not one
mention. `auth` was harder to catch: the word appears six times in prose
(`auth.hill90.com`, `HILL90_UI_CLIENT_SECRET`, `hill90-ui`), which is enough
for a reader skimming for coverage to see it mentioned and move on, but there
was no `make deploy-auth` or equivalent anywhere. Steps 4-6 below close all
three. **The Makefile itself had no targets for any of them either** — a
bigger gap than the runbook's prose, since a runbook author reaching for this
file's own `make deploy-X` convention had nothing to reach for; `deploy-db`,
`deploy-auth` and `deploy-minio` are added to the Makefile in the same change
as this runbook fix, not papered over with a raw `deploy.sh` invocation that
breaks the pattern every other step in this document follows.

**The order below is not a guess.** It is read directly from
[`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml), the
real, already-running production deploy pipeline — its jobs declare
`needs: [db]` for auth, `needs: [auth]` for minio, `needs: [minio]` for vault,
each with its own reasoning in that file's comments: Keycloak stores realms in
Postgres, so `deploy-auth` waits for `deploy-db`; MinIO validates OIDC tokens
against Keycloak, so `deploy-minio` is ordered after `deploy-auth` (ordering
by convention, not a hard runtime requirement — the workflow's own comment
says MinIO starts fine with Keycloak absent, only federated S3 login needs
it); `deploy-vault` and `deploy-observability` are serialized after that for
operational reasons (#778 — parallel deploy jobs raced on the same VPS
checkout and on service restarts), not a data dependency. This runbook is
brought into agreement with that pipeline, not inventing a second, competing
order.

**This sequence has NOT been executed end to end.** It is derived from
`deploy.yml`'s dependency graph and `scripts/deploy.sh`'s own code-enforced
guard (`cmd_service`'s auth step queries Postgres directly and `die`s with
"Deploy it first: bash scripts/deploy.sh db" if it cannot — the one
dependency enforced in code, not just in the pipeline's job graph), not
proven by running a real rebuild — the VPS cannot be rebuilt to test a
documentation change. What would prove it: running Steps 1-8 against a real
rebuild (or, short of that, standing up db/auth/minio/vault/observability in
this exact order against a disposable host or the standalone local stack) and
confirming each step succeeds before the next begins, the same standard
h#807's vault section already holds itself to ("Not verified here...").

## Prerequisites

- **Local machine:** Repository cloned, all tools installed
- **Age key:** `infra/secrets/keys/age-prod.key` — at that path in your **working copy**,
  not in the repository. It is gitignored and in no backup, so a fresh clone does not
  bring it and neither does a restore. Get it from your password manager first; see
  [`disaster-recovery.md`](disaster-recovery.md#step-0)
- **SSH key:** `~/.ssh/remote.hill90.com` configured
- **Secrets:** `infra/secrets/prod.enc.env` with VPS credentials
- **`HILL90_UI_CLIENT_SECRET` set in the store — check this BEFORE starting, not after
  login breaks.** h#809, `Verified 2026-08-06` against a real
  `quay.io/keycloak/keycloak:26.4.0` importing the actual `platform-realm.json` with
  this variable deliberately unset: the import completes with **no warning or error**
  ("Realm 'platform' imported" / "Import finished successfully"), and the `hill90-ui`
  client's resulting secret is the **literal, unsubstituted string
  `${HILL90_UI_CLIENT_SECRET}`** — not empty, and not random. That exact string is
  sitting in plaintext in `platform-realm.json` in this repository, so an unconfigured
  rebuild installs a client secret, for the client fronting `hill90.com`, that anyone
  reading this file already knows. This bites **only** on a first realm import — the
  case a rebuild is — and nothing in the automated rebuild path checks for it; a
  compose-level `${VAR:?...}` guard was considered and is deliberately **not** the fix,
  because `HILL90_UI_CLIENT_SECRET` is legitimately unset on every *routine* auth
  deploy after the first import (`start --import-realm` no-ops once the realm exists),
  so a blanket guard would refuse every normal deploy, not just protect this case (see
  `fad9fefa`, which rejected exactly that for exactly this reason). Confirm the value is
  present — `grep -c '^HILL90_UI_CLIENT_SECRET=' infra/secrets/prod.enc.env` should
  print `1` — before running Step 1. If it prints `0`, get the value from Jon first;
  it must equal what hill90-app's own store holds for `AUTH_KEYCLOAK_SECRET`, or the
  tenant app cannot sign in against the freshly-imported realm.

## Rebuild Workflow

### Step 0: Create Snapshot (Optional but Recommended)

Create a safety backup before destroying the VPS:

```bash
make snapshot
```

**Note:** Hostinger allows only 1 snapshot per VPS (overwrites existing).

---

### Step 1: Recreate VPS OS (~3-5 minutes)

Rebuild the VPS OS via Hostinger API:

```bash
make recreate-vps
```

**What happens automatically:**
1. Generates new Tailscale auth key via API (90-day expiry)
2. Updates `TAILSCALE_AUTH_KEY` in encrypted secrets
3. Generates random root password
4. Rebuilds VPS OS via Hostinger API (AlmaLinux 10)
5. Waits for rebuild completion (~135 seconds)
6. Retrieves new VPS public IP
7. Updates `VPS_IP` in encrypted secrets
8. Displays next command to run

**Result:**
- ✅ VPS OS rebuilt (AlmaLinux 10)
- ✅ New VPS IP captured in secrets
- ✅ New Tailscale auth key generated
- ❌ No services running yet

---

### Step 2: Bootstrap Infrastructure (~3-5 minutes)

Bootstrap infrastructure and deploy Traefik + Portainer:

```bash
make config-vps VPS_IP=<ip>
```

Use the VPS IP displayed by Step 1.

**What happens automatically:**
1. Runs Ansible bootstrap (9 playbooks)
   - Creates deploy user with SSH keys
   - Installs Docker and Docker Compose
   - Configures firewall (HTTP/HTTPS public, SSH Tailscale-only)
   - Installs Tailscale and joins network
   - Hardens SSH configuration
   - Installs SOPS and age for secrets
   - Clones repository to `/opt/hill90/app`
   - Transfers age encryption key
   - Deploys Traefik + Portainer (infrastructure only)
2. **Automatically updates DNS records** to new VPS IP
3. Extracts Tailscale IP from Ansible output
4. Updates `TAILSCALE_IP` in encrypted secrets

**Result:**
- ✅ Infrastructure ready (Docker, Tailscale, firewall)
- ✅ Traefik running (with DNS-01 certificates for Tailscale-only access)
- ✅ Portainer running (with DNS-01 certificates for Tailscale-only access)
- ✅ DNS records updated
- ✅ SSH locked to Tailscale network only

**Infrastructure services deployed:**
- `traefik.hill90.com` - Traefik dashboard (Tailscale-only, authenticated)
- `portainer.hill90.com` - Portainer UI (Tailscale-only)

---

### Step 3: Deploy Infrastructure Services (~1-2 minutes)

Deploy infrastructure services (Traefik, Portainer):

```bash
make deploy-infra
```

**What happens automatically:**
1. Decrypts secrets with SOPS
2. Deploys Traefik and Portainer
3. Requests DNS-01 Let's Encrypt certificates for Tailscale-only services

**Infrastructure services deployed:**
- `traefik.hill90.com` - Traefik dashboard (Tailscale-only, authenticated)
- `portainer.hill90.com` - Portainer UI (Tailscale-only)

**Result:**
- ✅ Infrastructure services running
- ✅ DNS-01 certificates active for Tailscale-only services

---

### Step 4: Deploy Database (~1 minute)

**h#831 — previously absent from this runbook entirely.** Deploy PostgreSQL,
the platform database:

```bash
make deploy-db
```

**Why this has to happen before Step 5:** Keycloak (Step 5) stores every realm
in this Postgres instance and will not start against an unreachable one —
`scripts/deploy.sh`'s own `cmd_service` queries Postgres directly before
deploying `auth` and `die`s with "Deploy it first: bash scripts/deploy.sh db"
if it cannot. This is a code-enforced dependency, not a documentation
convention — deploying `auth` before this step fails, it does not degrade.

**Result:**
- ✅ PostgreSQL running, reachable on the internal network

---

### Step 5: Deploy Auth (~1 minute)

**h#831 — previously absent from this runbook entirely.** Deploy Keycloak,
the platform identity provider:

```bash
make deploy-auth
```

**Requires Step 4 (Database) to have completed** — see above.

**Read the Prerequisites section above before this step, not after.**
`HILL90_UI_CLIENT_SECRET` must already be set in the secrets store. This is
the ONE step in the whole rebuild where `start --import-realm` actually
imports (a fresh Keycloak has no existing realm), and an unset value here
installs a public, unsubstituted placeholder as the client secret fronting
`hill90.com` — see the Prerequisites section for the full mechanism (h#809,
h#835) and the automated check that now catches it
(`verify_realm_secrets_substituted` in `scripts/keycloak.sh`, wired into
`keycloak.sh apply`, which `deploy.sh auth` calls automatically).

**Result:**
- ✅ Keycloak running, realm `platform` imported
- ✅ `auth.hill90.com` serving

---

### Step 6: Deploy MinIO (~1 minute)

**h#831 — previously absent from this runbook entirely.** Deploy MinIO,
platform object storage:

```bash
make deploy-minio
```

**Ordered after Step 5 (Auth), matching `deploy.yml`'s own convention — but
this is NOT a hard runtime dependency, stated so nobody assumes it is.**
MinIO validates OIDC tokens against Keycloak for federated S3 login, but the
container itself starts fine with Keycloak absent, and root-credential access
is unaffected. The pipeline orders it after `auth` anyway (`deploy.yml`:
`deploy-minio` `needs: [deploy-auth]`) because that is the order this estate
has already committed to elsewhere, not because MinIO would fail otherwise —
this runbook follows the same convention rather than inventing a
looser-but-different one.

**Result:**
- ✅ MinIO running, `storage.hill90.com` serving
- ⚠️ Federated (Keycloak SSO) login to MinIO's console will not work until
  Step 7 (Vault) has run `setup-oidc` and the realm role → MinIO policy
  mapping is in place. Root credentials work immediately.

---

### Step 7: Deploy AND Configure Vault

```bash
make deploy-vault
```

Deploys OpenBao and calls `vault.sh auto-unseal` automatically after compose up.

**This alone is not enough (h#807).** `Verified 2026-08-06` by diffing this step
against `disaster-recovery.md`'s: `make deploy-vault` deploys OpenBao and auto-unseals
it against whatever volume already exists, but on a truly fresh rebuild that volume is
empty — there is nothing to unseal yet, and `auto-unseal` exits 0 gracefully in that
case rather than failing. Deploying alone does **not** initialize, configure, or seed
the vault, and does not generate AppRole credentials. Following only this step leaves
a vault that is deployed and answering `bao status`, but has no KV v2 mount, no
AppRole roles, no secrets loaded, and no service credentials — and because every
service that authenticates against vault already has a SOPS fallback, `make health`
would plausibly still report clean while everything silently runs on SOPS instead
(the same shape as Hill90#791, but a documentation gap here rather than a runtime
one).

**Do the following instead, in order** — this is [`disaster-recovery.md`](disaster-recovery.md)'s
[Step 4](disaster-recovery.md#step-4) through Step 9, not repeated here to avoid the
two runbooks drifting out of sync with each other the way this gap itself happened:

1. [Initialize](disaster-recovery.md#step-4) — `bash scripts/vault.sh init`, **AND** push the
   new unseal key into SOPS before doing anything else. `vault.sh init` mints a
   **brand-new** unseal key and root token (`bao operator init`, run fresh against an
   empty volume) — it does **not** reuse or need `main`'s existing `OPENBAO_UNSEAL_KEY`,
   and a reader who assumes it does will look for the wrong value. `cmd_init` writes
   the new key to disk on the VPS (`/opt/hill90/secrets/openbao-unseal.key`,
   deliberately never printed — h#805) and nowhere else; [Step 4](disaster-recovery.md#step-4)'s
   own `scp` + `make secrets-update KEY=OPENBAO_UNSEAL_KEY` sequence is what gets it
   into SOPS, from your **workstation**, not the VPS. Skipping that half of the linked
   step leaves this rebuild's vault working right now but with no durable copy of its
   own unseal key anywhere but the host that could fail next — the same class of
   single point of failure #799 already found in the OTHER direction (a stale key in
   SOPS that no longer matches the live vault).
2. Unseal — `bash scripts/vault.sh unseal`
3. Setup (KV v2, AppRole auth, audit logging, policies, service roles) — `bash scripts/vault.sh setup`
4. Seed from SOPS — `bash scripts/vault.sh seed`
5. Configure OIDC (Keycloak) — `bash scripts/vault.sh setup-oidc`
6. Generate and store AppRole credentials — `bash scripts/vault.sh bootstrap-approles`

> **Step 6 (`bootstrap-approles`) depends on a credential that only exists for a
> narrow window, and this sequence has to stay unbroken for it to work.**
> `Verified 2026-08-06` by reading `cmd_bootstrap_approles` in `scripts/vault.sh`
> directly. It needs a root token, and gets one one of two ways:
>
> - **An already-exported `BAO_TOKEN`, used as-is if valid.** In this sequence, that's
>   the SAME root token Step 1's `vault.sh init` just wrote to
>   `/opt/hill90/secrets/openbao-root.token` — reused the same way Steps 3-5 above
>   already do (`BAO_TOKEN="$(cat /opt/hill90/secrets/openbao-root.token)"`). Followed
>   in order, with nothing in between that revokes it, this step works.
> - **Otherwise, it tries to generate a temporary one — and this fallback is
>   currently dead, unconditionally, not just sometimes.** `cmd_bootstrap_approles`'s
>   own `die` message says so: the `bao operator generate-root` CLI command it calls
>   "targets a LEGACY endpoint and returns 403 on 2.6.1 **whatever the
>   configuration** — it cannot mint one here." The message names the real fallback
>   as `vault-regain-root.yml` (a deliberate recovery-config redeploy with two vault
>   restarts, not a routine step) or supplying an existing root token by hand.
>
> **This entangles with Hill90#832, found the same day this runbook was corrected.**
> #832 established that OUTSIDE a fresh-init window like this one — i.e. on the
> normal, already-configured, already-running production vault, where root is
> deliberately revoked as standing policy — there is currently **no automation
> credential able to write to vault at all**. The only path #832 identifies is a
> **human** logging into `vault.hill90.com` via Keycloak SSO (`platform-admin` role →
> `policy-oidc-admin`, which grants full `create/read/update/delete/list` on
> `secret/*`) — and #832 is explicit that even that path "has not been exercised
> recently" for an actual write.
>
> **What this means for this step specifically:** if you run Steps 1-6 above in order,
> without interruption, on a truly fresh vault, `bootstrap-approles` rides the
> just-minted root token and should work — this is the scenario this runbook
> documents. If this sequence is ever interrupted **after** root is revoked (Step 13
> in `disaster-recovery.md`, or any other point root is deliberately dropped) and
> `bootstrap-approles` needs to be re-run later, **there is currently no known
> automatable way to get it a valid credential** — the generate-root fallback is
> dead by the script's own admission, and the human OIDC path is unexercised. That
> is a real gap, stated here rather than written around; see #832 for the credential
> problem itself, which this runbook does not attempt to resolve.

**Not verified here** whether `vault.sh auto-unseal` against a truly fresh,
never-initialized `openbao-data` volume errors cleanly, hangs, or silently no-ops —
what's stated above is the intended sequence from `disaster-recovery.md`, not a
rebuild that was run to confirm it. What would settle it: running `make deploy-vault`
alone against a disposable vault instance and observing what `auto-unseal` actually
does when there is nothing to unseal.

---

### Step 8: Deploy Observability (~1 minute)

```bash
make deploy-observability   # or: bash scripts/deploy.sh observability prod
```

**What happens automatically:**
1. Validates configuration
2. Decrypts secrets with SOPS
3. Deploys Prometheus, Alertmanager, Blackbox Exporter, Grafana, Loki, Tempo, Promtail,
   node-exporter and cAdvisor — nine services (h#808: `Verified 2026-08-06` against
   `docker-compose.observability.yml` directly; this list previously omitted
   Alertmanager and Blackbox Exporter, both real and already deployed)
4. Waits for containers to become healthy

**Result:**
- ✅ Nine observability containers running. **h#831 recount**, against every
  compose file listed in this runbook directly, not carried over from the prior
  figure: infra 2 (traefik, portainer) + db 2 (postgres, postgres-exporter) +
  auth 1 (keycloak) + minio 1 + vault 1 (openbao) + observability 9 = **16
  platform containers total, not 12.** The prior "12" figure (h#808) predates
  Steps 4-6 existing in this runbook at all — it was never wrong for what it
  counted, it counted a rebuild that was missing three stacks.
- ✅ Grafana at https://grafana.hill90.com (Tailscale-only)
- ✅ Prometheus scrape targets healthy

**Not verified against the live host** — this correction is against the compose files
directly (see the code-side fix, h#808, for the observability figure specifically),
not a container count taken from a running rebuild.

---

### Step 9: Health Verification

**A container reporting `unhealthy` partway through a rebuild is usually not a
failure.** A rebuilt host starts every service against empty volumes, and
several do one-time first-boot work before they can answer a probe at all —
Keycloak imports the realm and migrates its schema, OpenBao initialises, Tempo
builds its local blocks. Their healthchecks budget for it (`keycloak`
`start_period: 90s`, `tempo` `180s`, `openbao` `60s`), so the window in which
they legitimately look dead is minutes, not seconds.

Intervening during that window is the actual risk. Let
`bash scripts/ops.sh health` be the judge rather than `docker ps` read early
(`ops.sh`, not `make` — `make` is not installed on the VPS).

Verify all services are healthy:

```bash
make health
```

**Checks performed:**
- ✅ All sixteen Docker containers running (infra 2 + db 2 + auth 1 + minio 1 +
  vault 1 + observability 9 — h#831 recount, see Step 8)
- ✅ Traefik dashboard accessible (https://traefik.hill90.com via Tailscale)
- ✅ Portainer accessible (https://portainer.hill90.com via Tailscale)
- ✅ Grafana accessible (https://grafana.hill90.com via Tailscale)
- ✅ OpenBao unsealed (https://vault.hill90.com via Tailscale)
- ✅ DNS resolution correct for all domains
- ✅ SSL certificates valid

---

## Post-Rebuild Tasks

### 1. DNS Records (Automatically Updated)

DNS records are **automatically updated** during Step 2 (config-vps).

**Automatic updates:**
- `@` (hill90.com) → A record to new VPS IP
- `api.hill90.com` → A record to new VPS IP
- `ai.hill90.com` → A record to new VPS IP (serves MCP gateway)
- `auth.hill90.com` → A record to new VPS IP
- `portainer.hill90.com` → A record to new Tailscale IP
- `traefik.hill90.com` → A record to new Tailscale IP
- `storage.hill90.com` → A record to new Tailscale IP

**Verification:**
```bash
make dns-verify

# Or manually:
dig +short api.hill90.com
dig +short ai.hill90.com     # MCP gateway
dig +short hill90.com
dig +short portainer.hill90.com  # Tailscale IP
dig +short traefik.hill90.com    # Tailscale IP
dig +short storage.hill90.com    # Tailscale IP
```

### 2. Verify Tailscale Connection

Check Tailscale status on VPS:
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip> 'tailscale status'
# Should show: VPS online with Tailscale IP
```

Check local Tailscale connection:
```bash
tailscale status
# Should show VPS (hill90-vps) online
```

### 3. Verify SSH Access

**Test SSH via Tailscale (should SUCCEED):**
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>
```

**Test SSH via public IP (should FAIL):**
```bash
ssh -i ~/.ssh/remote.hill90.com deploy@<public-ip>
# Connection refused - firewall blocks SSH from public internet
```

Firewall is configured during bootstrap to only allow SSH from Tailscale network (100.64.0.0/10).

---

## Rollback Procedures

### Restore from Snapshot

If rebuild fails catastrophically, restore from the snapshot created in Step 0:

1. Login to [Hostinger hPanel](https://hpanel.hostinger.com/)
2. Navigate to VPS section → Your VPS
3. Go to **Snapshots** tab
4. Click **Restore** on the snapshot
5. Confirm restoration
6. Wait ~5 minutes for restoration to complete

**Note:** Snapshot restoration is a destructive operation that wipes all current VPS data.

### Manual Recovery via Hostinger API

If you need to restore via API:

```bash
# List available snapshots
bash scripts/hostinger.sh vps snapshot get

# Restore from snapshot (if snapshot exists)
bash scripts/hostinger.sh vps snapshot restore
```

---

## Troubleshooting

### Bootstrap Fails

**Symptom:** Ansible bootstrap fails during playbook execution

**Resolution:**
1. Check SSH connectivity: `ssh root@<vps-ip>`
2. Review Ansible logs for specific error
3. Re-run bootstrap: `make config-vps VPS_IP=<ip>`

### Deploy Fails

**Symptom:** `make deploy-infra` or `make deploy-observability` fails

**Common causes:**
- Age key not transferred correctly
- Secrets decryption failure
- Docker image build failure

**Resolution:**
```bash
# Check age key
ssh deploy@<vps-ip> "ls -la /opt/hill90/secrets/keys/keys.txt"

# Test secrets decryption
sops -d infra/secrets/prod.enc.env

# Review deploy logs
ssh deploy@<vps-ip> "cd /opt/hill90/app && docker compose logs"
```

### DNS Not Updating

**Symptom:** Health checks show DNS mismatch

**Resolution:**
1. Wait 5-10 minutes for DNS propagation
2. Flush local DNS: `sudo dscacheutil -flushcache` (macOS)
3. Verify DNS provider records updated correctly

---

## Automation Summary

**Manual steps:**
1. (Optional) Create snapshot: `make snapshot`
2. Recreate VPS: `make recreate-vps`
3. Bootstrap infrastructure: `make config-vps VPS_IP=<ip>`
4. Deploy infrastructure: `make deploy-infra`
5. Deploy database: `make deploy-db` (h#831)
6. Deploy auth: `make deploy-auth` — requires Step 5 (h#831)
7. Deploy MinIO: `make deploy-minio` (h#831)
8. Deploy vault: `make deploy-vault`
9. Initialize, unseal, configure, seed and generate AppRole credentials for vault,
   including pushing the freshly-minted unseal key into SOPS — see
   [Step 7](#step-7-deploy-and-configure-vault) above; **not automated**, and
   not optional (h#807)
10. Deploy observability: `make deploy-observability`
11. Verify health: `make health`

**Fully automated (no intervention):**
- ✅ Tailscale auth key generation and rotation
- ✅ VPS OS rebuild via Hostinger API
- ✅ IP retrieval and secret updates
- ✅ User creation (deploy user with SSH keys)
- ✅ Docker installation
- ✅ Firewall configuration (HTTP/HTTPS public, SSH Tailscale-only)
- ✅ Tailscale network join
- ✅ SSH hardening (root login disabled, password auth disabled)
- ✅ SOPS and age installation
- ✅ Repository cloning to `/opt/hill90/app`
- ✅ Age key transfer
- ✅ **Infrastructure deployment (Traefik + Portainer)**
- ✅ **DNS record updates**
- ✅ Application deployment
- ✅ Let's Encrypt certificate acquisition (HTTP-01 + DNS-01)
- ✅ Health verification

**Total rebuild time:** ~8-13 minutes (3-5 min + 3-5 min + 2-3 min)

**What that figure does not include.** It covers the platform steps above and
nothing else. The **tenant application is a separate repository with a
manually-dispatched deploy** and is not part of a rebuild; its first deploy onto
a rebuilt host is the slow one, because every database is empty and services
migrate before they serve. `litellm` alone has been measured taking minutes in
that state.

Those measurements live in the tenant repo:
[hill90-app — Cold start: which healthchecks survive an empty database](https://github.com/jonhill90/hill90-app/blob/main/docs/runbooks/cold-start-budgets.md).

**They are not platform numbers.** They were taken on an Apple Silicon laptop
against the tenant stack, not on the VPS, and this hardware is different. Read
them for the *shape* of the problem — first boot is minutes, later boots are
seconds, and the gap is what makes an optimistic timeout look fine until a
rebuild — not as an ETA for this host.

**Not measured on the VPS:** cold-start time for any platform service after a
real rebuild. The figures above are estimates carried from earlier rebuilds; the
next rebuild is the chance to replace them with observed numbers, and it is
worth capturing them while it runs.

---

## Security Considerations

1. **Root password:** Generated randomly, used only during OS rebuild, never stored permanently
2. **SSH access:** Locked to Tailscale network only (100.64.0.0/10) after bootstrap completes
3. **Firewall:** HTTP/HTTPS public, SSH from Tailscale network only (configured via firewalld)
4. **Secrets:** Encrypted with SOPS + age, decrypted only on VPS during deployment
5. **SSL/TLS:** Automatic via Traefik + Let's Encrypt
   - HTTP-01 challenge for public services (api, MCP gateway, ui)
   - DNS-01 challenge for Tailscale-only services (traefik, portainer)
6. **Traefik authentication:** Password hash auto-generated from encrypted secrets, bcrypt format
7. **IP whitelisting:** Tailscale services protected by IP whitelist middleware (100.64.0.0/10)
8. **Tailscale key rotation:** New auth key generated on every rebuild (90-day expiry)

---

## Related Documentation

- [Bootstrap Runbook](bootstrap.md)
- [Contributing Guide](../../CONTRIBUTING.md)
- [Health Check Script](../../scripts/ops.sh)
- [hill90-app — cold-start budgets](https://github.com/jonhill90/hill90-app/blob/main/docs/runbooks/cold-start-budgets.md)
  — measured start-up times for the tenant stack, and why an optimistic
  `start_period` only fails on a rebuild. Tenant measurements, not platform ones.
