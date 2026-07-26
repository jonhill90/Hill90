# Troubleshooting Guide

Common issues and solutions for Hill90 VPS infrastructure.

## VPS Access Issues

### Cannot SSH to VPS

**Problem**: SSH connection refused or times out

**Solutions**:

1. **Check Tailscale connection:**
   ```bash
   tailscale status
   # Verify VPS shows as online
   ```

2. **Verify Tailscale IP:**
   ```bash
   make secrets-view KEY=TAILSCALE_IP
   # Use this IP, not the public IP
   ```

3. **Test SSH via Tailscale:**
   ```bash
   ssh -i ~/.ssh/remote.hill90.com deploy@<tailscale-ip>
   ```

4. **Public SSH is blocked by design:**
   - SSH is only accessible via Tailscale network (100.64.0.0/10)
   - Public IP SSH access will be refused (firewall blocks port 22 from internet)
   - This is expected behavior for security

5. **Check SSH key permissions:**
   ```bash
   chmod 600 ~/.ssh/remote.hill90.com
   ```

---

## Service Not Starting

### Service Fails to Start

**Problem**: Docker container exits or won't start

**Solutions**:

1. **Check service logs:**
   ```bash
   make logs-<service>
   # Or directly:
   ssh deploy@<tailscale-ip> 'docker logs <service>'
   ```

2. **Verify secrets decryption:**
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && \
     export SOPS_AGE_KEY_FILE=/opt/hill90/secrets/keys/keys.txt && \
     sops -d infra/secrets/prod.enc.env | head -5'
   ```

3. **Check Docker Compose status:**
   ```bash
   # Use the per-service compose file (e.g., docker-compose.auth.yml, docker-compose.api.yml)
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && \
     docker compose -f deploy/compose/prod/docker-compose.<service>.yml ps'
   ```

4. **Restart service:**
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && \
     docker compose -f deploy/compose/prod/docker-compose.<service>.yml restart <service>'
   ```

5. **Check age key exists:**
   ```bash
   ssh deploy@<tailscale-ip> 'ls -la /opt/hill90/secrets/keys/keys.txt'
   # Should show: -rw------- 1 deploy deploy
   ```

---

## TLS Certificate Issues

### HTTP-01 Certificate Not Issued (Public Services)

**Problem**: Let's Encrypt certificate not issued for api.hill90.com, etc.

**Solutions**:

1. **Verify DNS records:**
   ```bash
   dig +short api.hill90.com
   dig +short ai.hill90.com   # MCP gateway
   # Should return VPS public IP
   ```

2. **Check Traefik logs:**
   ```bash
   make logs-traefik
   # Or:
   ssh deploy@<tailscale-ip> 'docker logs traefik | grep -i acme'
   ```

3. **Verify ports 80/443 are accessible:**
   ```bash
   curl -I http://api.hill90.com
   # Should return HTTP 308 redirect to HTTPS
   ```

4. **Wait for DNS propagation:**
   - DNS changes can take 5-10 minutes
   - Use `make dns-verify` to check propagation

5. **Check for rate limiting:**
   - Let's Encrypt production: 5 failures/hour, 50 certs/week
   - If rate limited, wait 1 hour and use staging certificates for testing
   - Deploy infrastructure: `make deploy-infra`

### DNS-01 Certificate Not Issued (Tailscale Services)

**Problem**: Let's Encrypt certificate not issued for traefik.hill90.com or portainer.hill90.com

**Solutions**:

1. **Read the Traefik log for the actual challenge result.** There is no
   separate DNS service; lego runs inside Traefik. Do not infer success from the
   container being healthy — Traefik stays healthy through a failed renewal.
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs traefik --tail 100 | grep -i "acme\|certificate\|challenge"'
   ```

2. **Common DNS-01 issues:**

   **a. Missing or under-scoped CF_DNS_API_TOKEN:**
   ```
   Error: cloudflare: failed to find zone hill90.com: ... HTTP status 403
   ```
   **Fix:** The token needs Zone/Zone/Read *and* Zone/DNS/Edit on `hill90.com`.
   Verify it is set and actually reached the container:
   ```bash
   make secrets-view KEY=CF_DNS_API_TOKEN
   ssh deploy@<tailscale-ip> 'docker exec traefik env | grep CF_DNS'
   ```

   **b. Zone not authoritative yet:**
   ```
   Error: cloudflare: ... zone could not be found
   ```
   **Fix:** Nameservers must point at Cloudflare. A zone still in `pending`
   status is not serving the domain.

   **c. Rate limited:**
   ```
   Error: 429 :: too many failed authorizations (5) for "traefik.hill90.com"
   ```
   **Fix:** Wait an hour and retry against the staging CA.

3. **Verify DNS TXT records appear _and then disappear_:**
   ```bash
   dig TXT _acme-challenge.traefik.hill90.com @1.1.1.1
   # Present during the challenge, removed by lego afterwards.
   # A record that lingers means cleanup is failing.
   ```

5. **Verify Traefik DNS-01 configuration:**
   ```bash
   ssh deploy@<tailscale-ip> 'cat /opt/hill90/app/platform/edge/traefik.yml | grep -A5 dnsChallenge'
   ```

6. **Rate limiting:**
   - Same limits as HTTP-01 (5 failures/hour, 50 certs/week)
   - Use staging certificates during development

### Certificate Verification

**Check certificate issuer:**
```bash
echo | openssl s_client -connect api.hill90.com:443 -servername api.hill90.com 2>/dev/null | \
  openssl x509 -noout -issuer
```

**Expected:**
- **Production:** `issuer=C=US, O=Let's Encrypt, CN=R12`
- **Staging:** `issuer=C=US, O=(STAGING) Let's Encrypt, CN=(STAGING) Ersatz Edamame E1`

---

## DNS Management Issues

### DNS Not Updating

**Problem**: DNS records don't reflect new VPS IP after rebuild

**Solutions**:

1. **Check current DNS records:**
   ```bash
   make dns-view
   ```

2. **Verify secrets are correct:**
   ```bash
   make secrets-view KEY=VPS_IP
   make secrets-view KEY=TAILSCALE_IP
   ```

3. **Manually sync DNS:**
   ```bash
   make dns-sync
   ```

4. **Check DNS propagation:**
   ```bash
   make dns-verify
   # Or manually:
   dig +short hill90.com @8.8.8.8
   dig +short api.hill90.com @8.8.8.8
   ```

5. **Clear local DNS cache (macOS):**
   ```bash
   sudo dscacheutil -flushcache
   sudo killall -HUP mDNSResponder
   ```

6. **Wait for propagation:**
   - DNS changes can take 5-10 minutes globally
   - Some ISPs cache longer (up to 1 hour)

### DNS API Errors

**Problem**: DNS updates fail via Hostinger API

**Solutions**:

1. **Verify API key:**
   ```bash
   make secrets-view KEY=HOSTINGER_API_KEY
   ```

2. **Check rate limiting:**
   - Wait 5-10 minutes if hitting rate limits
   - Use `make dns-snapshots` to verify snapshots exist

3. **Restore from DNS snapshot:**
   ```bash
   make dns-snapshots
   make dns-restore SNAPSHOT_ID=<id>
   ```

---

## Traefik Authentication Issues

### Cannot Access Traefik Dashboard

**Problem**: Authentication fails at traefik.hill90.com

**Solutions**:

1. **Verify accessing via Tailscale:**
   ```bash
   tailscale status
   # Ensure you're connected to Tailscale network
   ```

2. **Check .htpasswd file:**
   ```bash
   ssh deploy@<tailscale-ip> 'cat /opt/hill90/app/platform/edge/dynamic/.htpasswd'
   # Should show: admin:$2y$05$...
   ```

3. **Verify password hash in secrets:**
   ```bash
   make secrets-view KEY=TRAEFIK_ADMIN_PASSWORD_HASH
   # Should show bcrypt hash starting with $2y$
   ```

4. **Redeploy to regenerate .htpasswd:**
   ```bash
   make deploy-infra
   ```

5. **Check middleware configuration:**
   ```bash
   ssh deploy@<tailscale-ip> 'cat /opt/hill90/app/platform/edge/dynamic/middlewares.yml'
   ```

### Traefik Dashboard Not Accessible

**Problem**: Connection refused to traefik.hill90.com

**Solutions**:

1. **Verify Traefik is running:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker ps | grep traefik'
   ```

2. **Check DNS points to Tailscale IP:**
   ```bash
   dig +short traefik.hill90.com
   # Should return Tailscale IP (100.x.x.x), not public IP
   ```

3. **Verify IP whitelist middleware:**
   - Dashboard is only accessible from Tailscale network (100.64.0.0/10)
   - Public internet access is blocked by design

---

## Secrets Decryption Failures

### Cannot Decrypt Secrets

**Problem**: SOPS decryption fails

**Solutions**:

1. **Verify age key exists locally:**
   ```bash
   ls -la infra/secrets/keys/age-prod.key
   ```

2. **Verify age key on VPS:**
   ```bash
   ssh deploy@<tailscale-ip> 'ls -la /opt/hill90/secrets/keys/keys.txt'
   ```

3. **Check SOPS configuration:**
   ```bash
   cat infra/secrets/.sops.yaml
   ```

4. **Test decryption locally:**
   ```bash
   export SOPS_AGE_KEY_FILE=infra/secrets/keys/age-prod.key
   sops -d infra/secrets/prod.enc.env | head -5
   ```

5. **Restore age key to VPS:**
   ```bash
   scp -i ~/.ssh/remote.hill90.com \
     infra/secrets/keys/age-prod.key \
     deploy@<tailscale-ip>:/opt/hill90/secrets/keys/keys.txt

   ssh deploy@<tailscale-ip> 'chmod 600 /opt/hill90/secrets/keys/keys.txt'
   ```

---

## Observability Issues

### Grafana Not Accessible

**Problem**: Cannot reach `grafana.hill90.com`

**Solutions**:

1. **Verify Tailscale connection** — Grafana is Tailscale-only:
   ```bash
   tailscale status
   ```

2. **Check DNS points to Tailscale IP:**
   ```bash
   dig +short grafana.hill90.com
   # Should return 100.x.x.x (Tailscale IP)
   ```

3. **Check Grafana container:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker ps | grep grafana'
   ssh deploy@<tailscale-ip> 'docker logs grafana --tail 20'
   ```

### Prometheus Targets Down

**Problem**: Scrape targets show `down` in Prometheus

**Solutions**:

1. **Check target status:**
   ```bash
   curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | select(.health != "up") | {job: .labels.job, health: .health, lastError: .lastError}'
   ```

2. **Verify network connectivity** — all targets must be on `hill90_internal`:
   ```bash
   docker network inspect hill90_internal --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

3. **Check scrape config** — verify job exists in `platform/observability/prometheus/prometheus.yml`.

### No Traces in Tempo

**Problem**: Grafana Explore → Tempo shows no traces

**Solutions**:

1. **Verify OTEL env vars** in service compose files:
   - `OTEL_EXPORTER_OTLP_ENDPOINT` should point to `http://tempo:4318` (HTTP) or `http://tempo:4317` (gRPC)
   - `OTEL_TRACES_EXPORTER=otlp`

2. **Check Tempo receiver health:**
   ```bash
   curl -s http://localhost:3200/ready
   ```

3. **Check service logs for OTEL errors:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs api --tail 50 | grep -i otel'
   ```

4. **Verify Tempo distributor is receiving traces:**
   ```bash
   curl -s http://localhost:3200/metrics | grep tempo_distributor
   ```

### No Logs in Loki

**Problem**: Grafana Explore → Loki shows no logs

**Solutions**:

1. **Check Promtail is running and connected:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker ps | grep promtail'
   ssh deploy@<tailscale-ip> 'docker logs promtail --tail 20'
   ```

2. **Verify Docker socket mount** — Promtail needs `/var/run/docker.sock`.

3. **Check Promtail positions** — if positions file is corrupted, delete the `promtail-positions` volume and redeploy.

### Alert Rules Not Loading

**Problem**: Prometheus Alerts page shows no rules

**Solutions**:

1. **Verify `rule_files` in prometheus.yml** includes `/etc/prometheus/alerts.yml`.

2. **Check alerts.yml is mounted** in `docker-compose.observability.yml`.

3. **Validate syntax:**
   ```bash
   docker exec prometheus promtool check rules /etc/prometheus/alerts.yml
   ```

### Dashboard Not Showing Data

**Problem**: Grafana dashboard panels show "No data"

**Solutions**:

1. **Check datasource configuration** — Settings → Data Sources → test connection.

2. **Verify time range** — default dashboards may expect recent data. Expand the time range.

3. **Check Prometheus has the expected metrics:**
   ```bash
   curl -s 'http://localhost:9090/api/v1/query?query=up' | jq '.data.result[] | {job: .metric.job, value: .value[1]}'
   ```

### Exporter Healthcheck Caveats

The Docker healthcheck for `promtail` uses a `--version` flag, which only validates binary presence. This means:

- Docker reports `healthy` even if the upstream connection to Loki is broken.
- `ops.sh health` relies on Docker health state and will show green for these exporters regardless.
- **Always verify Prometheus target status** for connection truth, especially after infrastructure changes.

---

## Vault Issues

### Vault Sealed After Reboot

**Problem**: OpenBao is sealed after VPS reboot and services cannot read secrets

**Solutions**:

1. **Check if auto-unseal ran:**
   ```bash
   ssh deploy@<tailscale-ip> 'journalctl -u hill90-vault-unseal --no-pager'
   ```

2. **Manual unseal:**
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && bash scripts/vault.sh unseal'
   ```

3. **Check unseal key file permissions:**
   ```bash
   ssh deploy@<tailscale-ip> 'ls -la /opt/hill90/secrets/openbao-unseal.key'
   # Expected: -rw------- 1 deploy deploy
   ```

4. **Fix permissions if wrong:**
   ```bash
   ssh deploy@<tailscale-ip> 'sudo chown deploy:deploy /opt/hill90/secrets/openbao-unseal.key && sudo chmod 600 /opt/hill90/secrets/openbao-unseal.key'
   ```

### Auto-Unseal Service Not Running

**Problem**: `hill90-vault-unseal` systemd service is not enabled

**Solutions**:

1. **Enable and start:**
   ```bash
   ssh deploy@<tailscale-ip> 'sudo systemctl enable hill90-vault-unseal && sudo systemctl start hill90-vault-unseal'
   ```

2. **Re-run Ansible bootstrap (installs the service):**
   ```bash
   make config-vps VPS_IP=<ip>
   ```

### Deploy Verify Fails for Vault

**Problem**: `deploy.sh verify vault` reports sealed

**Solutions**:

1. **Run auto-unseal manually:**
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && bash scripts/vault.sh auto-unseal'
   ```

2. **Check vault status:**
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && bash scripts/vault.sh status'
   ```

---

## For More Help

- **Check service logs:** `make logs` or `make logs-<service>`
- **Review configuration:** Files in `deploy/` and `infra/`
- **Consult documentation:**
  - [Architecture Overview](../architecture/overview.md)
  - [Certificate Management](../architecture/certificates.md)
  - [Observability Runbook](./observability.md)
  - [VPS Rebuild Runbook](./vps-rebuild.md)
  - [Bootstrap Runbook](./bootstrap.md)
- **GitHub Actions logs:** Repository → Actions → Recent workflow runs
- **Hostinger status:** https://status.hostinger.com
- **Tailscale status:** https://status.tailscale.com
