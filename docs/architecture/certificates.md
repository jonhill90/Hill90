# Certificate Management Architecture

## Overview

Hill90 uses Let's Encrypt for SSL/TLS certificates with two different challenge methods:

1. **HTTP-01** - For public services (api, ai, mcp)
2. **DNS-01** - For Tailscale-only services (traefik, portainer)

## Why DNS-01 for Tailscale Services?

**Problem:** Traefik and Portainer are accessible ONLY via Tailscale network (100.64.0.0/10), not from the public internet.

**HTTP-01 limitations:**
- Let's Encrypt validation servers must connect to port 80/443
- Requires service to be publicly accessible
- Cannot validate Tailscale-only services

**DNS-01 solution:**
- Let's Encrypt validates via DNS TXT records
- No public HTTP access required
- Works for any domain, even private/internal services

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Let's Encrypt (Validation Server)                          │
└─────────────────────────────────────────────────────────────┘
                    │                        │
                    │ HTTP-01               │ DNS-01
                    │ (port 80)             │ (DNS query)
                    ▼                        ▼
        ┌───────────────────┐    ┌───────────────────┐
        │ Public Services   │    │ DNS Records       │
        │ - api.hill90.com  │    │ _acme-challenge.  │
        │ - ai.hill90.com   │    │   traefik.hill90  │
        └───────────────────┘    └───────────────────┘
                    │                        │
                    │                        │
                    ▼                        ▼
        ┌───────────────────┐    ┌───────────────────┐
        │ Traefik (HTTP-01) │    │ dns-manager       │
        │ Challenges        │    │ (Custom Webhook)  │
        └───────────────────┘    └───────────────────┘
                                           │
                                           ▼
                                 ┌───────────────────┐
                                 │ Hostinger DNS API │
                                 └───────────────────┘
```

## DNS-01 Challenge Implementation

### Custom Webhook (dns-manager)

**Location:** `src/services/dns-manager/app.py`

**Purpose:** Translates Lego httpreq provider format to Hostinger DNS API

**Endpoints:**
- `POST /present` - Create DNS TXT record for challenge
- `POST /cleanup` - Delete DNS TXT record after validation
- `GET /health` - Health check

**Challenge Flow:**

1. **Traefik requests certificate:**
   ```
   Traefik → Lego ACME client → httpreq provider
   ```

2. **Lego calls dns-manager:**
   ```http
   POST /present
   {
     "domain": "traefik.hill90.com",
     "token": "...",
     "keyAuth": "..."
   }
   ```

3. **dns-manager computes TXT value:**
   ```python
   # ACME DNS-01 requires: base64url(SHA256(keyAuth))
   hash_digest = hashlib.sha256(key_auth.encode()).digest()
   value = base64.urlsafe_b64encode(hash_digest).decode().rstrip('=')
   ```

4. **dns-manager creates DNS record:**
   ```python
   # Via Hostinger API
   PUT /api/dns/v1/zones/hill90.com
   {
     "zone": [{
       "name": "_acme-challenge.traefik",
       "type": "TXT",
       "ttl": 300,
       "records": [{"content": "<computed-value>"}]
     }]
   }
   ```

5. **Traefik waits for DNS propagation:**
   ```yaml
   # traefik.yml
   dnsChallenge:
     delayBeforeCheck: 30s  # Wait for DNS to propagate
   ```

6. **Let's Encrypt validates:**
   ```
   dig TXT _acme-challenge.traefik.hill90.com
   → Matches expected value → Certificate issued
   ```

7. **dns-manager cleans up:**
   ```http
   POST /cleanup
   {
     "domain": "traefik.hill90.com"
   }
   ```

### Traefik Configuration

**Certificate Resolvers:**

```yaml
# deployments/platform/edge/traefik.yml

certificatesResolvers:
  # HTTP-01 for public services
  letsencrypt:
    acme:
      email: admin@hill90.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web

  # DNS-01 for Tailscale-only services
  letsencrypt-dns:
    acme:
      email: admin@hill90.com
      storage: /letsencrypt/acme-dns.json
      dnsChallenge:
        provider: httpreq
        delayBeforeCheck: 30s
        resolvers:
          - 1.1.1.1:53
          - 8.8.8.8:53
```

**Environment Variables:**

```yaml
# deployments/compose/prod/docker-compose.yml

environment:
  - HTTPREQ_ENDPOINT=http://dns-manager:8080
  - HTTPREQ_MODE=RAW
```

**Router Labels:**

```yaml
# Tailscale-only service using DNS-01
labels:
  - "traefik.http.routers.traefik.tls.certresolver=letsencrypt-dns"
  - "traefik.http.routers.traefik.middlewares=auth@file,tailscale-only@file"
```

## Critical DNS-01 Implementation Details

### 1. Lego httpreq Provider Format

The dns-manager MUST handle Lego's httpreq provider format:

**Request fields:**
- `domain` - Base domain (e.g., "traefik.hill90.com")
- `token` - ACME token (NOT the final TXT value!)
- `keyAuth` - Key authorization string

**Common mistake:** Using `token` as the TXT value. The correct value is `base64url(SHA256(keyAuth))`.

### 2. TXT Record Construction

**FQDN construction:**
```python
fqdn = f"_acme-challenge.{domain}"
# Example: _acme-challenge.traefik.hill90.com
```

**Record name for Hostinger API:**
```python
# Remove base domain from FQDN
record_name = fqdn[:-len(f".{BASE_DOMAIN}")]
# Example: _acme-challenge.traefik
```

### 3. Timing Considerations

**DNS propagation delay:**
- Traefik waits 30s (`delayBeforeCheck: 30s`)
- dns-manager should NOT sleep - return immediately
- Let Traefik handle the wait

**Timeout issues:**
- If dns-manager blocks for 30s, Traefik times out
- HTTP request must complete quickly
- DNS propagation happens asynchronously

## Troubleshooting

### Certificate Acquisition Failures

**Check dns-manager logs:**
```bash
ssh deploy@<vps-ip> 'docker logs dns-manager --tail 50'
```

**Common issues:**

1. **Wrong TXT value:**
   ```
   Error: did not return the expected TXT record [value: expected] actual: token
   ```
   **Fix:** Ensure dns-manager computes `base64url(SHA256(keyAuth))`, not using `token` directly.

2. **Timeout during /present:**
   ```
   Error: context deadline exceeded (Client.Timeout exceeded while awaiting headers)
   ```
   **Fix:** Remove `time.sleep()` from dns-manager - Traefik handles the delay.

3. **Missing fqdn parameter:**
   ```
   Error: {"error":"Missing fqdn or value"}
   ```
   **Fix:** dns-manager should accept both `fqdn` and `domain` parameters.

4. **Rate limiting:**
   ```
   Error: 429 :: too many failed authorizations (5) for "traefik.hill90.com"
   ```
   **Fix:** Wait 1 hour, use STAGING certificates for testing.

### DNS Record Verification

**Check if TXT record was created:**
```bash
dig TXT _acme-challenge.traefik.hill90.com @8.8.8.8
```

**Check Hostinger DNS records:**
```bash
make dns-view | grep _acme-challenge
```

### Certificate Verification

**Check certificate issuer:**
```bash
echo | openssl s_client -connect traefik.hill90.com:443 -servername traefik.hill90.com 2>/dev/null | \
  openssl x509 -noout -issuer
```

**Expected:**
```
issuer=C=US, O=Let's Encrypt, CN=R12  # Production
issuer=C=US, O=(STAGING) Let's Encrypt, CN=(STAGING) Ersatz Edamame E1  # Staging
```

## Rate Limits

**Let's Encrypt Production:**
- 50 certificates per registered domain per week
- 5 validation failures per account per hostname per hour

**Let's Encrypt Staging:**
- Much higher limits (for testing)
- Not trusted by browsers (expect certificate warnings)

**Best practices:**
1. Use staging certificates during development
2. Only switch to production when ready
3. Test DNS-01 implementation thoroughly before production
4. Monitor certificate expiry (auto-renewal at 60 days)

## Security Considerations

1. **Hostinger API Key:** Stored in SOPS-encrypted secrets
2. **DNS records:** Only TXT records created (no A/CNAME modification)
3. **Challenge cleanup:** dns-manager removes TXT records after validation
4. **Middleware protection:** Tailscale-only services use IP whitelist middleware

## References

- **ACME DNS-01 Spec:** [RFC 8555 Section 8.4](https://datatracker.ietf.org/doc/html/rfc8555#section-8.4)
- **Lego httpreq Provider:** [lego documentation](https://go-acme.github.io/lego/dns/httpreq/)
- **dns-manager Implementation:** `src/services/dns-manager/app.py`
- **Traefik ACME Docs:** [traefik.io/traefik/https/acme](https://doc.traefik.io/traefik/https/acme/)
