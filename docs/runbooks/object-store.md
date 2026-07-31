# Object store (MinIO)

MinIO is a platform primitive — the Storage Account equivalent. Background and
the decisions behind it: [object-store.md](../decisions/object-store.md).

- Console: `https://storage.hill90.com` — **root credentials only**
- S3 API: `http://minio:9000` on the internal network, **not routed externally**
- Locally: `http://storage.localtest.me:8080`

## Logging in

**The console has no SSO button, and adding one is not possible on a current
release.** MinIO removed the management console from the AGPL build in May 2025.
Sign in with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from SOPS.

Keycloak identities work on the **S3/STS path** instead — see below. If you are
looking for the SSO story for the other services, that is
[sso-fallback.md](sso-fallback.md).

## Getting S3 credentials from a Keycloak identity

A user with realm role `admin`, `editor` or `viewer` can exchange a Keycloak
token for temporary S3 credentials. The realm role name is carried in the
`minio_policy` claim, and MinIO grants the policy of that name — which is why
`scripts/minio.sh apply` creates policies called `admin`, `editor` and `viewer`.
Without them every federated login is rejected with "no policy found".

```bash
# 1. Obtain an OIDC token for the `minio` client however you normally would.
# 2. Exchange it. Note the parameters go in the BODY, form-encoded — passing
#    them in the query string returns "unsupported API call for method: POST".
curl -X POST "http://minio:9000/" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "Action=AssumeRoleWithWebIdentity" \
  --data-urlencode "Version=2011-06-15" \
  --data-urlencode "DurationSeconds=900" \
  --data-urlencode "WebIdentityToken=$ID_TOKEN"
```

The response carries `AccessKeyId`, `SecretAccessKey` and `SessionToken`. With
`mc`, the session token goes in the alias URL:

```bash
export MC_HOST_fed="http://${AK}:${SK}:${ST}@minio:9000"
mc ls fed
```

**Verified end to end locally**: a Keycloak user with realm role `admin`
exchanged a token for credentials and wrote a 29-byte object.

## Policies

| Realm role | MinIO policy | Grants |
|---|---|---|
| `admin` | `admin` | `s3:*` plus `admin:*` |
| `editor` | `editor` | get/put/delete objects, list buckets |
| `viewer` | `viewer` | get objects, list buckets |

`scripts/minio.sh apply` provisions them and is idempotent. `deploy.sh minio`
runs it automatically; a failure there is non-fatal and leaves root access
unaffected.

Note the `admin` policy needs `s3:*` and `admin:*` in **separate statements** —
MinIO treats any statement containing an `admin:` action as admin-only and
rejects `s3:*` inside it with `unsupported admin action 's3:*'`.

## The first certificate issuance — read before deploying

`storage.hill90.com` has **never issued a certificate** under the current ACME
configuration (issue #538). Nothing was broken: there was no router for the host,
so nothing ever asked. This deploy adds the router and therefore triggers the
first issuance.

**Deploy this after the Cloudflare ACME migration (#535).** While `main` still
uses the `httpreq` provider pointed at the Hostinger `dns-manager` shim, a
DNS-01 challenge writes to a zone Hostinger no longer serves. Validation fails
and Traefik presents its default self-signed certificate — the exact untrusted
state this work exists to end.

### Watching it, rather than assuming it

```bash
# On the VPS, after `deploy.sh minio prod`:

# 1. Is a router registered for the host at all?
docker exec traefik wget -qO- http://localhost:8080/api/http/routers \
  | grep -o 'minio-console[^,]*'

# 2. Did ACME store a certificate for it?
docker exec traefik sh -c 'cat /letsencrypt/acme-dns.json' \
  | grep -o 'storage\.hill90\.com'

# 3. What is actually served?
echo | openssl s_client -connect storage.hill90.com:443 \
  -servername storage.hill90.com 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

Expected: `subject=CN=storage.hill90.com` with a real expiry. If it says
`CN=TRAEFIK DEFAULT CERT`, issuance failed — check Traefik's log for the ACME
error and confirm which DNS provider is configured before retrying, because
Let's Encrypt rate-limits repeated failures.

**Rolling back the certificate attempt** is just removing the router: redeploy
without the MinIO stack, or unset the resolver. Nothing else depends on it.

## Local development

```bash
bash scripts/local.sh up     # brings up MinIO with the rest of the stack
bash scripts/local.sh sso    # Keycloak client + MinIO policies
```

The local override maps `auth.localtest.me` to `host-gateway`, because MinIO
validates OIDC tokens server-side and `localtest.me` resolves to `127.0.0.1` —
which inside a container is the container itself. Without it the OIDC config
loads but no token ever validates.

## Backups

`backup.sh backup minio` tars the `prod_minio-data` volume, and `deploy.sh minio`
runs it before recreating the container. There is no `mc mirror` step: the volume
is the whole store, and mirroring would need somewhere to mirror to.

The volume was never deleted when MinIO was removed in #495, so a restore on the
VPS may find existing objects. That is also why the root credentials are reused
rather than rotated — rotating them is a separate, deliberate act.
