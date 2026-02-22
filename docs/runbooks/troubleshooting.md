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

**Problem**: Let's Encrypt certificate not issued for api.hill90.com, ai.hill90.com, etc.

**Solutions**:

1. **Verify DNS records:**
   ```bash
   dig +short api.hill90.com
   dig +short ai.hill90.com
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
   - Deploy applications: `make deploy-all`

### DNS-01 Certificate Not Issued (Tailscale Services)

**Problem**: Let's Encrypt certificate not issued for traefik.hill90.com or portainer.hill90.com

**Solutions**:

1. **Check dns-manager logs:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs dns-manager --tail 50'
   ```

2. **Common DNS-01 issues:**

   **a. Wrong TXT value:**
   ```
   Error: did not return the expected TXT record [value: expected] actual: token
   ```
   **Fix:** Ensure dns-manager computes `base64url(SHA256(keyAuth))`, not using `token` directly.

   **b. Timeout during /present:**
   ```
   Error: context deadline exceeded (Client.Timeout exceeded while awaiting headers)
   ```
   **Fix:** Remove `time.sleep()` from dns-manager - Traefik handles the delay via `delayBeforeCheck: 30s`.

   **c. Missing HOSTINGER_API_KEY:**
   ```
   Error: 401 Unauthorized
   ```
   **Fix:** Verify secret is set:
   ```bash
   make secrets-view KEY=HOSTINGER_API_KEY
   ```

3. **Verify DNS TXT records:**
   ```bash
   dig TXT _acme-challenge.traefik.hill90.com @8.8.8.8
   # Should show TXT record during challenge
   ```

4. **Check dns-manager connectivity:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker exec dns-manager curl -f http://localhost:8080/health'
   # Should return: {"status":"healthy"}
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
   make deploy-all
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

## Database Connection Issues

### Services Can't Connect to PostgreSQL

**Problem**: Services fail with database connection errors

**Solutions**:

1. **Check PostgreSQL is running:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker ps | grep postgres'
   ```

2. **Verify credentials in secrets:**
   ```bash
   make secrets-view KEY=DB_PASSWORD
   make secrets-view KEY=DB_USER
   make secrets-view KEY=POSTGRES_DB
   ```

3. **Check internal network connectivity:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker exec api ping -c 3 postgres'
   ```

4. **Review PostgreSQL logs:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs postgres --tail 50'
   ```

5. **Test database connection:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker exec -it postgres psql -U <user> -d <database> -c "\l"'
   ```

---

## Keycloak Issues

### Keycloak Not Starting

**Problem**: Keycloak container exits or fails health check

**Solutions**:

1. **Verify PostgreSQL is running:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker ps | grep postgres'
   ```
   Keycloak requires PostgreSQL. Deploy it first: `make deploy-db`

2. **Check Keycloak logs:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs keycloak --tail 50'
   ```

3. **Verify OIDC endpoint:**
   ```bash
   curl -f https://auth.hill90.com/realms/hill90/.well-known/openid-configuration
   ```

### Authentication Flow Not Working

**Problem**: Users cannot log in via the UI

**Solutions**:

1. **Check Keycloak is accessible:**
   ```bash
   curl -f https://auth.hill90.com/realms/hill90
   ```

2. **Verify secrets:**
   ```bash
   make secrets-view KEY=AUTH_KEYCLOAK_ID
   make secrets-view KEY=AUTH_KEYCLOAK_SECRET
   make secrets-view KEY=AUTH_SECRET
   ```

3. **Check UI logs:**
   ```bash
   ssh deploy@<tailscale-ip> 'docker logs ui --tail 50'
   ```

---

## Email Delivery Issues

### Keycloak Emails Not Sending

**Problem**: Password reset or verification emails are not delivered

**Solutions**:

1. **Test connection from Keycloak admin console:**
   - Navigate to Realm Settings → Email → Test connection
   - A successful test confirms SMTP credentials and network path

2. **Verify SMTP_PASSWORD in SOPS:**
   ```bash
   bash scripts/secrets.sh view infra/secrets/prod.enc.env SMTP_PASSWORD
   ```

3. **Re-apply SMTP config via deploy:**
   ```bash
   bash scripts/deploy.sh auth prod
   ```
   Phase1 of `setup-realm.sh` re-injects SMTP settings via the Keycloak REST API.

4. **Check DNS email authentication records:**
   ```bash
   # SPF
   dig TXT hill90.com +short
   # Should include: "v=spf1 include:_spf.hostinger.email ~all"

   # DKIM
   dig CNAME hostingermail-a._domainkey.hill90.com +short
   dig CNAME hostingermail-b._domainkey.hill90.com +short
   dig CNAME hostingermail-c._domainkey.hill90.com +short

   # DMARC
   dig TXT _dmarc.hill90.com +short
   ```

5. **Verify Hostinger SMTP credentials:**
   - Username: `noreply@hill90.com`
   - Managed at the Hostinger email panel (hpanel.hostinger.com → Emails)
   - SMTP host: `smtp.hostinger.com`, port `587`, STARTTLS

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

Docker healthchecks for `promtail` and `postgres-exporter` use `--version` flags, which only validate binary presence. This means:

- Docker reports `healthy` even if the upstream connection (Loki, PostgreSQL) is broken.
- `ops.sh health` relies on Docker health state and will show green for these exporters regardless.
- **Always verify Prometheus target status** for connection truth, especially after infrastructure changes.

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
