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
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && \
     docker compose -f deployments/compose/prod/docker-compose.yml ps'
   ```

4. **Restart service:**
   ```bash
   ssh deploy@<tailscale-ip> 'cd /opt/hill90/app && \
     docker compose -f deployments/compose/prod/docker-compose.yml restart <service>'
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
   - Staging: `make deploy` (unlimited)
   - Production: `make deploy-production` (rate-limited)

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
   ssh deploy@<tailscale-ip> 'cat /opt/hill90/app/deployments/platform/edge/traefik.yml | grep -A5 dnsChallenge'
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
   ssh deploy@<tailscale-ip> 'cat /opt/hill90/app/deployments/platform/edge/dynamic/.htpasswd'
   # Should show: admin:$2y$05$...
   ```

3. **Verify password hash in secrets:**
   ```bash
   make secrets-view KEY=TRAEFIK_ADMIN_PASSWORD_HASH
   # Should show bcrypt hash starting with $2y$
   ```

4. **Redeploy to regenerate .htpasswd:**
   ```bash
   make deploy
   ```

5. **Check middleware configuration:**
   ```bash
   ssh deploy@<tailscale-ip> 'cat /opt/hill90/app/deployments/platform/edge/dynamic/middlewares.yml'
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
   make secrets-view KEY=POSTGRES_PASSWORD
   make secrets-view KEY=POSTGRES_USER
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

## For More Help

- **Check service logs:** `make logs` or `make logs-<service>`
- **Review configuration:** Files in `deployments/` and `infra/`
- **Consult documentation:**
  - [Architecture Overview](../architecture/overview.md)
  - [Certificate Management](../architecture/certificates.md)
  - [VPS Rebuild Runbook](./vps-rebuild.md)
  - [Bootstrap Runbook](./bootstrap.md)
- **GitHub Actions logs:** Repository → Actions → Recent workflow runs
- **Hostinger status:** https://status.hostinger.com
- **Tailscale status:** https://status.tailscale.com
