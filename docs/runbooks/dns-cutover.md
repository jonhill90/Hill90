# DNS Cutover Runbook — Hostinger to Cloudflare

Moving authoritative DNS for `hill90.com` from Hostinger to Cloudflare without
interrupting mail. Mail stays on Hostinger; only DNS authority moves.

**Execute the steps in order: 0, 1, 2, 3, 4, 5, 6, 7, 7a, 8, 8a, 9, 10.**
Background and reasoning are in the Reference section *after* the procedure — you
do not need to read it first, but Step 2 has a 4-hour wait and Step 4 depends on
another lane, so read the lead-time table below before you begin.

> **The single most important thing on this page:** #535 is **merged** at Step 4,
> before the nameserver change, and **deployed** at Step 7a, after it. Merging and
> deploying are separate actions that go in opposite directions. Deploying early
> breaks certificate issuance for every host. This distinction is easy to collapse
> under pressure — do not.

Related: [Certificates](../architecture/certificates.md), issue #529, issue #538.

## Lead times — start these first

| Step | Owner | Lead time |
|---|---|---|
| **1 — Cloudflare API token** | — | **Done.** Minted, in SOPS, verified against the live zone. No longer a prerequisite. |
| **2 — Lower Hostinger TTLs (T1)** | Jon | **≥ 4 hours of waiting** before Step 6. Recommended, not optional — see Reference A. |
| **4 — MERGE #535 and #540** | dns-manager lane | Days. Both merged **before** Step 6. **Merge only — do not deploy.** |
| **6 — Nameserver change (J3)** | **Jon alone** | Then a **24-hour** window (Step 10), not 48. |
| **7a — DEPLOY #535** | dns-manager lane | Only *after* Cloudflare is answering. Deploying earlier breaks all issuance. |
| **8a — Verify DNS-01 issuance** | You | **Hard deadline 2026-08-13** — the first certificate renewal. |
| **9 — Mail send/receive (J4)** | Jon | The step that decides success. |

Commands are written for **macOS**, since that is where the operator sits.
`watch`, `date -d`, `xargs -r` and `grep -P` are GNU-only and are deliberately
avoided. `timeout` is Homebrew-only and is not used.

## How to read the output of these checks

Every step below tells you to run a command and confirm something. The failure
mode to guard against is **reading output against what you expect rather than
against what the step actually asserts.**

This is not hypothetical. While writing this runbook, a verification run printed
NS TTLs of `86400` from one resolver and `21600` from another — directly
contradicting a sentence written moments earlier claiming those values must be
identical. The output was read, looked broadly right, and the contradiction was
missed for two revisions. A later audit caught it.

So: after running a command, re-read the assertion it was meant to test, then
check the output against *that sentence*, not against your memory of what the
system does. Where an assertion is easy to misread, the steps below say
explicitly what does and does not count — for example that different NS **TTLs**
are meaningless while different NS **names** are the failure being hunted.

If output and intent disagree, the intent is not automatically right. One of them
is wrong and it is worth a minute to find out which.

## Command portability

`openssl` **is** used, in Steps 8 and 8a. Stock `/usr/bin/openssl` on macOS is
LibreSSL (3.3.6 as tested) and works fine — but it formats subjects differently
from Homebrew's OpenSSL:

```
LibreSSL : subject= /CN=TRAEFIK DEFAULT CERT
OpenSSL  : subject=CN=TRAEFIK DEFAULT CERT
```

Note the leading space and slash. `issuer` diverges further — the field
separators differ too, not just the prefix:

```
LibreSSL : issuer= /C=US/O=Let's Encrypt/CN=YR2
OpenSSL  : issuer=C=US, O=Let's Encrypt, CN=YR2
```

Any `grep` or string comparison you write against that output must tolerate both,
or it will pass on one machine and fail on another. `O=Let's Encrypt` matches
both; a CN-anchored pattern does not.

Note also that a bare `openssl` resolves to whichever comes first on `PATH` —
with Homebrew installed that is OpenSSL, not the system LibreSSL. Do not assume
which one you are running; check with `openssl version` if a comparison behaves
oddly.

Always pipe `echo |` into `openssl s_client` — without stdin it waits on the
terminal and appears to hang.

---

# Procedure

## Step 0 — Confirm the break-glass path (blocking)

Prove SSH works with no DNS involved. The Tailscale CLI is inside the app bundle
and is **not** on `PATH`:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status | grep hill90-vps
# expect: 100.88.29.112   hill90-vps   tagged-devices   linux
```

```bash
ssh -i ~/.ssh/remote.hill90.com -o IdentitiesOnly=yes deploy@100.88.29.112 \
    'hostname; uptime'
```

`-i` and `-o IdentitiesOnly=yes` are load-bearing: `~/.ssh/config` binds the
deploy key to the *hostname*, not the IP, so connecting by IP without them falls
back to `~/.ssh/id_rsa`. That happens to work today only because `id_rsa` is also
authorised — luck, not the designed path.

**Do not proceed unless this returns a shell.**

*If it fails:* stop. Fix Tailscale or the deploy key first. There is no safe
cutover without a DNS-independent way in.

## Step 1 — Cloudflare API token — already done

**No action required.** The token exists and is scoped to the `hill90.com` zone
with Cloudflare's **Zone / Zone / Read** + **Zone / DNS / Edit** permissions.
It was reported verified against the live zone — creating and then deleting a TXT
record — by the operator who minted it on 2026-07-26. That verification is
attributed, not independently reproducible from this document: the scope and the
API test cannot be checked without the token itself.

It lives in SOPS as `CF_DNS_API_TOKEN` on the **dns-manager lane's branch**
(`refactor/cloudflare-dns`), wired at `docker-compose.infra.yml:49`. It is
**not on `main`** and arrives there when #535 lands — so if you check out `main`
and go looking for it, its absence is expected, not a problem.

This changes what the rest of the runbook can claim, but less than it might seem.
What is established is narrow: **the credential works against the Cloudflare
API.** That is a direct API call, not lego's write path from inside the Traefik
container — different code, different environment, different failure modes.

Everything downstream is still unproven: Traefik → lego → Cloudflare API → Let's
Encrypt validation cannot be exercised until Cloudflare is authoritative. That is
Step 8a, and it remains the one part of this runbook taking something on trust.

To confirm independently, from the lane's branch:

```bash
git show origin/refactor/cloudflare-dns:infra/secrets/prod.enc.env \
  | grep -c CF_DNS_API_TOKEN        # expect 1
```

## Step 2 — T1: lower Hostinger TTLs (Jon) — recommended

Set every Hostinger record's TTL to 300, then **wait at least 4 hours** before
Step 6 so the old 14400s MX TTL ages out.

Current TTLs: `MX` 14400, apex `A` / SPF / `_dmarc` / most `A` 3600, `CNAME` 300.

This is a recommendation, not a coin flip. Reference A explains why. If it is
skipped, Step 5 becomes the last cheap moment to catch a mistake — raise the bar
there accordingly, because after Step 6 every correction is slow.

Note this is the one sanctioned write to the Hostinger zone. It happens **before**
the freeze in Step 3 and before delegation. After Step 6, the Hostinger zone is
frozen.

## Step 3 — Freeze the things that issue certificates or write DNS

Announce a freeze. This is a mechanism, not a request to be careful — certificate
issuance happened **twice on 2026-07-26 with no container restart**, triggered by
an ordinary deploy:

```
vault  notBefore=Jul 26 07:14:33 2026   (DNS-01)
auth   notBefore=Jul 26 19:55:13 2026   (HTTP-01)
traefik StartedAt: 2026-07-21T03:02:30Z   ← no restart
```

**The freeze runs from here (Step 3) through Step 10 — not from Step 6.** The gap
matters: `make dns-sync` firing between Step 5's verification and Step 6's
delegation would desynchronise the zones *after* the diff that was supposed to
guarantee they match, and the delegation would proceed on a stale result. Step 5
is the most protective control in this runbook and its protection is worthless if
anything can write DNS between it and the cutover.

Two sanctioned exceptions:

- **Step 7a** deploys #535. That is a deploy and it recreates the Traefik
  container — see the two hazard checks in that step. Note **Step 4 does not
  deploy anything**; merging touches the repository only, so it is not a freeze
  exception at all.
- **Step 8a** adds a Traefik router for a scratch hostname, which the freeze list
  otherwise forbids. It is deliberate, uses a throwaway name, and is the only way
  to verify DNS-01 before the 2026-08-13 deadline.

Nothing else in the freeze list may run.

Freeze, from Step 3 until Step 10 closes:

**Writes DNS to Hostinger only — desynchronises the zones:**
- `make dns-sync`, `scripts/hostinger.sh dns sync|update|delete|reset`
- `.github/workflows/config-vps.yml` (contains a DNS sync step)
- `.github/workflows/recreate-vps.yml` (chains into the above)

**Triggers certificate issuance:**
- Any deploy that adds, removes or relabels a Traefik router
- `infra/ansible/playbooks/09-traefik.yml`. Beyond the DNS-01 change, it declares
  `storage: /letsencrypt/acme-http.json` at line 121 while the live
  `platform/edge/traefik.yml:65` uses `/letsencrypt/acme.json`. Running the
  playbook repoints the HTTP-01 store at a file that does not exist and forces
  reissuance of every HTTP-01 certificate.

All the workflows are `workflow_dispatch` only, so nothing fires unattended. The
risk is an operator reaching for VPS recovery mid-incident.

*If the VPS must genuinely be recreated during the window:* the Tailscale IP will
change, `dns sync` will update Hostinger, and Cloudflare will still hold the old
address. Update **both** zones by hand, then re-run Step 5.

## Step 4 — MERGE the Cloudflare DNS-01 change. Do NOT deploy it.

> **Merging and deploying are different actions and they go in opposite
> directions here.** Merge now, before the nameserver change. Deploy *after* it,
> at Step 7a. Collapsing the two breaks certificate issuance for everything.

Merge #535 (Traefik `dnsChallenge` from `provider: httpreq` to the lego-native
`provider: cloudflare`) and #540. **Both must be merged before Jon touches the
registrar at Step 6.** Merging changes the repository and nothing on the VPS.

### Why the deploy must wait until after delegation

Let's Encrypt validates DNS-01 against **the authoritative nameservers**. Right
now that is Hostinger:

```bash
dig +short NS hill90.com @1.1.1.1     # ns1.dns-parking.com. ns2.dns-parking.com.
```

The Cloudflare zone is still `pending`. So:

- **Deploy #535 now**, while Hostinger is authoritative, and lego writes the
  challenge TXT into the Cloudflare zone — which Let's Encrypt does not query.
  **Every issuance fails**, immediately and for as long as that state lasts.
- **Leave it undeployed**, and the current setup keeps working exactly as it does
  today: `dns-manager` writes to Hostinger, which is authoritative, and issuance
  succeeds.

The existing path is not a liability to be removed quickly — it is the *only*
working path until delegation moves. It stays deployed and correct right up to
the moment Cloudflare goes authoritative, and the new path goes in immediately
after.

This is also why #535 must not be deployed as a side effect of some other
deploy: it **removes the `dns-manager` service entirely** from
`docker-compose.infra.yml` (8 references on `main`, 0 on the lane branch). Once
deployed, the old path no longer exists.

### The changeover gap, and why it is safe

There is still a gap — between delegation (Step 6) and the deploy (Step 7a),
whichever way it is sequenced, DNS-01 is briefly broken. That gap is safe because
**nothing needs a certificate soon.** Renewal begins at 30 days remaining:

| Host | Expires | Renewal begins |
|---|---|---|
| `traefik`, `portainer`, `grafana` | 2026-09-12 | **~2026-08-13** |
| `vault`, `auth` | 2026-10-24 | ~2026-09-24 |

**The earliest renewal attempt is ~2026-08-13.** The gap is bounded by
certificate expiry, not by urgency — a deadline, not a race.

**Both** Traefik configs must change in the merge:
`platform/edge/traefik.yml:75` and the embedded copy in
`09-traefik.yml:131-132`. Changing one is a silent half-migration.

### Do not attempt the `acmetest` proof here

It cannot pass before delegation, for the same reason the deploy cannot. It is a
**post-cutover verification** (Step 8a), not a pre-cutover gate. Any reading of
this runbook that treats it as a prerequisite for Step 6 is wrong.

Deploy hazards are documented at Step 7a, where the deploy actually happens.

## Step 5 — Re-verify the zone immediately before delegation

Do not trust the earlier verification, and do not trust any JSON file in the repo
(`infra/dns/hill90.com.json` describes 7 records against a 32-record zone).

```bash
for NS in ns1.dns-parking.com adi.ns.cloudflare.com; do
  echo "===== @$NS ====="
  for n in @ admin ai api auth grafana litellm portainer remote storage \
           traefik vault vps; do
    [ "$n" = "@" ] && f=hill90.com || f=$n.hill90.com
    dig +noall +answer A "$f" @$NS
  done
  for n in www docs autoconfig autodiscover \
           hostingermail-a._domainkey hostingermail-b._domainkey \
           hostingermail-c._domainkey; do
    dig +noall +answer CNAME "$n.hill90.com" @$NS
  done
  dig +noall +answer MX  hill90.com @$NS
  dig +noall +answer TXT hill90.com @$NS
  dig +noall +answer TXT _dmarc.hill90.com @$NS
  dig +noall +answer SRV _minecraft._tcp.minecraft.hill90.com @$NS
  for n in admin grafana litellm portainer storage traefik vault; do
    dig +noall +answer TXT "_acme-challenge.$n.hill90.com" @$NS
  done
  dig +noall +answer NS  hill90.com @$NS
  dig +noall +answer SOA hill90.com @$NS
  dig +noall +answer TXT _domainconnect.hill90.com @$NS
done
```

That is all 32 records plus the three known-divergent items. Confirm:

- Every A record returns `100.88.29.112` or `76.13.26.69` — **never** Cloudflare
  anycast (`104.x`, `172.67.x`). Anycast means the record got proxied.
- MX is exactly `5 mx1.hostinger.com` / `10 mx2.hostinger.com`.
- Apex SPF is one line, single-quoted, no `_spfcf` includes.
- All three DKIM records return `type=CNAME`, not A or TXT.
- `autoconfig` / `autodiscover` return CNAMEs to `*.mail.hostinger.com`.
- The `_minecraft._tcp.minecraft` SRV is present.
- All seven `_acme-challenge` TXTs match. They are stale but must stay identical
  across both zones for the duration (Reference B).
- **Expected to differ:** `NS` and `SOA` (each provider serves its own), and
  `_domainconnect`, which exists only on Cloudflare.

*If any check fails:* stop. Fix the Cloudflare record, re-run this step in full.

## Step 6 — J3: change nameservers (Jon alone)

At Hostinger — the registrar (`HOSTINGER operations, UAB`) as well as the current
DNS host — replace:

```
ns1.dns-parking.com  →  adi.ns.cloudflare.com
ns2.dns-parking.com  →  art.ns.cloudflare.com
```

**Do not modify or delete anything in the Hostinger zone from here on.** It stays
intact as the rollback path. Observe the Step 3 freeze.

## Step 7 — Watch the delegation

`watch` is not available on macOS. Use a loop:

```bash
while :; do
  date
  dig NS hill90.com @a.gtld-servers.net +noall +authority
  echo "---"
  sleep 60
done
```

Poll public resolvers explicitly. Expect disagreement for roughly a day; treat
disagreement past ~30 hours as anomalous, not normal (Reference D):

```bash
for r in 1.1.1.1 8.8.8.8 9.9.9.9 208.67.222.222; do
  echo "$r: $(dig +short NS hill90.com @$r | tr '\n' ' ')"
done
```

## Step 7a — NOW deploy the Cloudflare DNS-01 change

**Only once the Cloudflare zone is actually serving.** Confirm before deploying —
this is the gate that Step 4's merge deliberately did not cross:

```bash
dig +short NS hill90.com @1.1.1.1     # must return adi/art.ns.cloudflare.com
dig +short SOA hill90.com @1.1.1.1    # MNAME must be adi.ns.cloudflare.com.
```

If those still show `dns-parking.com`, **do not deploy** — the old path is still
the working one. Wait, and re-check.

Once Cloudflare is answering, deploy #535. This removes `dns-manager` and points
Traefik's DNS-01 at the Cloudflare provider, matching the now-authoritative zone.

### Two deploy hazards, both silent

`ACME_CA_SERVER` is a compose interpolation into container args
(`deploy/compose/prod/docker-compose.infra.yml`), and **its default is staging**.
This deploy changes Traefik's `environment:` block, so it recreates the container.

The value is set in `infra/secrets/prod.enc.env`, so a normal SOPS-loaded deploy
gets production. **A deploy run without SOPS loaded silently points both
resolvers at staging.** Existing certificates are not replaced immediately —
Traefik skips any domain already in the store — so nothing looks wrong at the
time. The damage lands at renewal, around **2026-08-13**, when certificates
reissue against staging and every hostname starts serving an untrusted cert.
Silent for weeks. Pre-existing, not caused by #535.

#535 adds a second variable with the same shape and the same trap —
`CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN:-}` at `docker-compose.infra.yml:49`,
defaulting to **empty**. A SOPS-less deploy hands Traefik a blank Cloudflare
token, and the symptom does not surface until Step 8a.

Check both after deploying:

```bash
ssh -i ~/.ssh/remote.hill90.com -o IdentitiesOnly=yes deploy@100.88.29.112 \
  'docker inspect traefik --format "{{range .Args}}{{println .}}{{end}}" | grep caserver
   docker inspect traefik --format "{{range .Config.Env}}{{println .}}{{end}}" \
     | grep -q "^CF_DNS_API_TOKEN=." && echo "CF token: present" || echo "CF token: EMPTY"'
```

Expect `acme-v02` (production) and `CF token: present`. Anything else — redeploy
with secrets loaded before going further. The check deliberately does not print
the token.

## Step 8 — Verify through the window

**Pin the resolver on every check.** A bare `dig` goes to Tailscale MagicDNS at
`100.100.100.100`, which caches and will show stale answers.

Run the full record check against public resolvers. This is written out rather
than referring back to Step 5, because **the expectations invert after
delegation** and reusing Step 5's confirmation list would mislead you.

```bash
for R in 1.1.1.1 8.8.8.8; do
  echo "===== @$R ====="
  for n in @ admin ai api auth grafana litellm portainer remote storage \
           traefik vault vps; do
    [ "$n" = "@" ] && f=hill90.com || f=$n.hill90.com
    dig +noall +answer A "$f" @$R
  done
  for n in www docs autoconfig autodiscover \
           hostingermail-a._domainkey hostingermail-b._domainkey \
           hostingermail-c._domainkey; do
    dig +noall +answer CNAME "$n.hill90.com" @$R
  done
  dig +noall +answer MX  hill90.com @$R
  dig +noall +answer TXT hill90.com @$R
  dig +noall +answer TXT _dmarc.hill90.com @$R
  dig +noall +answer SRV _minecraft._tcp.minecraft.hill90.com @$R
  for n in admin grafana litellm portainer storage traefik vault; do
    dig +noall +answer TXT "_acme-challenge.$n.hill90.com" @$R
  done
  dig +noall +answer NS  hill90.com @$R
  dig +noall +answer SOA hill90.com @$R
  dig +noall +answer TXT _domainconnect.hill90.com @$R
done
```

Confirm — note how these differ from Step 5:

- All A, CNAME, MX, TXT and SRV values match the Step 5 capture.
- CNAME **targets** are right, not merely present: `www → hill90.com`,
  `docs → cname.mintlify-dns.com`, DKIM → `*.dkim.mail.hostinger.com`.
- Every A record returns `100.88.29.112` or `76.13.26.69` — **never** Cloudflare
  anycast (`104.x`, `172.67.x`).
- **Both resolvers must now return the same SET OF NAMESERVER NAMES** — compare
  the names only, **ignoring TTL and ordering**. This is the reverse of Step 5,
  where the two sides were expected to differ.

  Do **not** compare the lines literally. TTLs count down independently and are
  capped differently per resolver, and RRset order is not stable. All four of
  these were correct and on the same zone when measured:

  ```
  @1.1.1.1          86400
  @8.8.8.8          21389    (Google caps NS TTL at 21600)
  @9.9.9.9          43200
  @208.67.222.222   86400
  ```

  Compare with:

  ```bash
  for R in 1.1.1.1 8.8.8.8; do
    echo "$R: $(dig +short NS hill90.com @$R | sort | tr '\n' ' ')"
  done
  ```

  Different *names* means the resolvers are still on opposite zones — that is the
  split-brain this step exists to detect. Different TTLs mean nothing.

- `SOA` likewise: compare the MNAME (`adi.ns.cloudflare.com.`), not the whole
  record. The serial and TTL legitimately differ.
- **`_domainconnect` must now be present at BOTH resolvers.** In Step 5 it
  existed only on Cloudflare. Absent from one resolver means that resolver is
  still on Hostinger.
- Mixed results across the two resolvers are normal early in the window and
  expected to converge. Persisting past ~30 hours is anomalous — see Reference D.

*If a record is wrong:* correcting it is no longer cheap. The fix reaches only
the resolvers already on Cloudflare, and the rest on Hostinger's TTL — up to 4
hours for MX unless Step 2 was done. Fix it in **both** zones.

Then the public surface and SSH:

```bash
for r in 1.1.1.1 8.8.8.8; do
  echo "=== @$r ==="
  for h in hill90.com www.hill90.com api.hill90.com ai.hill90.com \
           auth.hill90.com docs.hill90.com; do
    echo "$h -> $(dig +short A "$h" @$r | tr '\n' ' ')"
  done
done
```

**SSH must be tested against a real lookup.** `ssh deploy@remote.hill90.com` does
**not** resolve the name — `~/.ssh/config` hardcodes `hostname 100.88.29.112`, so
it succeeds identically whether DNS is right, proxied, or NXDOMAIN.

```bash
IP=$(dig +short A remote.hill90.com @1.1.1.1 | head -1)
if [ -z "$IP" ]; then
  echo "FAIL: remote.hill90.com does not resolve"
elif [ "$IP" != "100.88.29.112" ]; then
  echo "FAIL: resolves to $IP, expected 100.88.29.112"
else
  ssh -i ~/.ssh/remote.hill90.com -o IdentitiesOnly=yes deploy@"$IP" 'hostname'
fi
```

If `$IP` is a `104.x` or `172.67.x` address the record got proxied. Fix it in
Cloudflare. Tailscale access itself is unaffected — the tailnet does not use
public DNS — but the `remote.hill90.com` alias, and anything else resolving that
name, is broken until it is corrected.

**Certificate warnings that are NOT cutover damage.** These hosts serve
`CN=TRAEFIK DEFAULT CERT` today, before any change, because no Traefik router
exists for them (issue #538):

```
hill90.com   www.hill90.com   api.hill90.com   ai.hill90.com
admin.hill90.com   litellm.hill90.com   storage.hill90.com
```

Confirm (note the `echo |`, without which `s_client` waits on the terminal):

```bash
for h in hill90.com www.hill90.com api.hill90.com ai.hill90.com \
         admin.hill90.com litellm.hill90.com storage.hill90.com; do
  printf '%-22s ' "$h"
  echo | openssl s_client -connect 100.88.29.112:443 -servername "$h" 2>/dev/null \
    | openssl x509 -noout -subject
done
```

A TLS warning on any of those is pre-existing, not cutover damage. Only
`traefik`, `portainer`, `grafana`, `vault` (DNS-01) and `auth` (HTTP-01) hold
real certificates. `remote` and `vps` also have no certificate, but are
SSH/non-web surfaces where it does not arise.

## Step 8a — Verify DNS-01 issuance now works (deadline: 2026-08-13)

Only possible here, once Cloudflare is authoritative. Until this passes, no
Tailscale-only host can renew — and the first one tries at **~2026-08-13**.

No A record is needed. DNS-01 validates purely on a TXT record, and the check
below connects by IP with SNI, so a scratch hostname needs **no** DNS record of
its own and no HTTP reachability. Adding one would only be zone churn that Step 5
cannot audit.

1. Add a Traefik router for a scratch hostname on the DNS-01 resolver. The file
   provider watches `/etc/traefik/dynamic` with `watch: true`, bind-mounted from
   **`/opt/hill90/app/platform/edge/dynamic` on the VPS** — so the file is
   created there, not in your local clone, and needs no deploy or restart.
   `deploy` can write to that directory.

   ```bash
   ssh -i ~/.ssh/remote.hill90.com -o IdentitiesOnly=yes deploy@100.88.29.112 \
     'cat > /opt/hill90/app/platform/edge/dynamic/acmetest.yml' <<"YAML"
   http:
     routers:
       acmetest:
         rule: "Host(`acmetest.hill90.com`)"
         entryPoints: [websecure]
         service: noop@internal
         tls:
           certResolver: letsencrypt-dns
   YAML
   ```

   Creating this file in your local checkout does nothing — that is the mistake
   that makes the rest of this step look like a silent failure.

2. Wait. Issuance is not instant: `delayBeforeCheck` is 30s and propagation adds
   more. **Allow 3–5 minutes** before concluding anything.

3. Check for *failures*. **This is a failure detector only — silence is the
   expected success signal.**

   ```bash
   ssh -i ~/.ssh/remote.hill90.com -o IdentitiesOnly=yes deploy@100.88.29.112 \
     'docker logs --since 10m -t traefik 2>&1 | grep -i acme | tail -40'
   ```

   Traefik runs at `log.level: INFO` (`platform/edge/traefik.yml`), and in v2.11
   every ACME *success* path logs at debug — only failures log at error. Verified:
   the two real issuances on 2026-07-26 (`vault` 07:14:33, `auth` 19:55:13)
   produced **zero** ACME log lines. So empty output here is what success looks
   like. Non-empty output means something went wrong; read it.

   The verdict is item 4, not this. `--since` and `-t` are load-bearing: without
   them you replay days of untimestamped history, and `-f` would never return.

4. Confirm on the wire:

   ```bash
   echo | openssl s_client -connect 100.88.29.112:443 \
     -servername acmetest.hill90.com 2>/dev/null \
     | openssl x509 -noout -subject -issuer
   ```

   **Expected:** a subject naming `acmetest.hill90.com`, and an issuer containing
   `O=Let's Encrypt` **without** `(STAGING)` in the CN. Formatting differs by
   openssl build (see the preamble), so match on `O=Let's Encrypt` and the
   absence of `(STAGING)`, not on an exact string.

   **Still `CN=TRAEFIK DEFAULT CERT` after 5 minutes?** Issuance did not happen.
   Check step 3's output, and confirm the file actually landed on the **VPS**
   (`ls /opt/hill90/app/platform/edge/dynamic/`) rather than in your clone.

5. Clean up:

   ```bash
   ssh -i ~/.ssh/remote.hill90.com -o IdentitiesOnly=yes deploy@100.88.29.112 \
     'rm /opt/hill90/app/platform/edge/dynamic/acmetest.yml'
   ```

   **This does not remove the certificate.** Traefik renews from the certificates
   in `acme-dns.json`, not from the routers that requested them, so once
   `acmetest.hill90.com` is issued it will keep renewing on the 30-day schedule
   forever — burning a validation for a hostname with no router, and logging a
   daily error if it ever fails. Removing it means editing the root-owned store
   in the `prod_traefik-certs` volume, with the same hazards described in Step 4.
   Either do that deliberately, or accept a permanent orphan and record the
   decision. There is no DNS record to clean up — one was never created.

Production allows 5 failed validations per hostname per hour, which is why this
uses a scratch name rather than a host you depend on.

## Step 9 — J4: prove mail actually works (Jon)

**This is the step that decides whether the migration succeeded.**

- Send from a `@hill90.com` mailbox to an external address.
- Receive at that mailbox from an external sender.
- Check headers on a received message: SPF `pass`, DKIM `pass`.

Everything before this shows that records resolve. Only this shows that mail
flows. Do not close the migration on Step 8.

*If mail fails:* correction latency is set by Step 2. With T1, minutes. Without
it, up to 4 hours for MX — and a full rollback is a day or more.

## Step 10 — Close out

**The window is closed when all of the following are true:**

1. At least **24 hours** have elapsed since Step 6. That is the 86400s child-zone
   NS TTL, which is what real resolvers actually serve — not the parent's
   172800s. See Reference D; do not wait out 48 hours by default.
2. All four public resolvers in Step 7 return the Cloudflare nameservers.
3. Step 9 has passed.

**If condition 2 has not been met by ~30 hours, stop waiting and investigate.**
Reference D item 2 describes resolvers that can self-refresh from Cloudflare and
may never re-consult the parent, so universal agreement is not guaranteed to
arrive on its own. At that point the window is not "still settling" — something
is wrong, or a specific resolver is stuck and should be treated as an exception
rather than a blocker. Do not let an unsatisfiable condition hold the freeze
open indefinitely.

Only then:

- Lift the Step 3 freeze.
- Normalise the explicit 3600 TTLs on `litellm` and `traefik` in Cloudflare to
  Auto; everything else is already 300.
- Sweep the seven stale `_acme-challenge` TXT records from **both** zones.
- Clean up the Hostinger zone.
- Retire the DNS commands in `scripts/hostinger.sh` — **dns-manager lane owns
  this.**
- **Keep `HOSTINGER_API_KEY`.** Still required for VPS operations:
  `scripts/vps.sh:195`, `.github/workflows/config-vps.yml:167`,
  `.github/workflows/recreate-vps.yml:68`. Removing it breaks VPS rebuild.

---

# Reference

## A. Why T1 (Step 2) is recommended rather than optional

An earlier draft called it a nice-to-have, on the grounds that both zones serve
identical records so a split is harmless and TTLs only affect speed. Two facts
break that.

**The zones cannot be identical for ACME.** Challenge TXT records live in exactly
one zone at a time by construction, and have a hard propagation deadline. Every
extra hour of split is another hour in which validation is nondeterministic.

**The repo's own tooling can desynchronise the zones.**
`scripts/hostinger.sh:356` writes seven A records — including `remote` — to
Hostinger only, reachable from `make dns-sync` and from CI. Hence the Step 3
freeze. "Identical zones make a split harmless" is an assumption nothing
enforces.

**What follows:** Step 8 and Step 9 exist to detect problems. Without T1, the
remedy for anything they find reaches only half the resolver population and takes
up to 4 hours. That is detection with no fast response, which is worse than not
detecting, because it manufactures the illusion of control.

Note the argument applies to **Step 8 and Step 9 only**. Step 5 runs before
delegation, when Cloudflare is authoritative for nobody and nothing caches its
answers — a wrong record found there is corrected in Cloudflare immediately, and
Hostinger's TTLs are irrelevant to it.

## B. Why the stale `_acme-challenge` records were kept

Round-1 review argued they were dangerous and should be deleted. They are not.
Per RFC 8555 §8.4, the ACME server verifies that *one of* the TXT records at the
name matches the expected digest; a stale non-matching value fails validation in
exactly the same way an absent record does. Keeping them costs nothing and
preserves the zones-identical property the window depends on.

They exist because `dns-manager`'s `/cleanup` has never successfully deleted a
record. That bug belongs to the dns-manager lane; note `delete_txt_record()`
posts `overwrite: True`, the same flag a prior fix removed from `hostinger.sh` as
a zone-wipe hazard. Sweep them in Step 10.

## C. Certificate state before the cutover

Two resolvers are configured in `platform/edge/traefik.yml`:

| Resolver | Challenge | Store | Holds |
|---|---|---|---|
| `letsencrypt` | HTTP-01 | `acme.json` | `auth.hill90.com` |
| `letsencrypt-dns` | DNS-01 | `acme-dns.json` | `traefik`, `portainer`, `grafana`, `vault` |

| Host | Expires | Traefik renews (30d) |
|---|---|---|
| `traefik`, `portainer`, `grafana` | 2026-09-12 | **~2026-08-13** |
| `vault` | 2026-10-24 | ~2026-09-24 |
| `auth` (HTTP-01) | 2026-10-24 | ~2026-09-24 |

Traefik v2.11's default `certificatesDuration` is 2160h, giving a 30-day renew
period checked daily. Verify the arithmetic with BSD `date`:
`date -v-30d -j -f '%Y-%m-%d' '2026-09-12' '+%Y-%m-%d'` → `2026-08-13`.

**HTTP-01 is unaffected by the delegation.** Both zones return identical A
records, so Let's Encrypt reaches port 80 either way. Only DNS-01 is at risk.

**Traefik runs its own pre-check before calling Let's Encrypt,** against
`1.1.1.1` and `8.8.8.8` with `delayBeforeCheck: 30s`. During a split those two
resolvers may be on opposite zones, so this pre-check is what fails first and is
what you will actually observe in the logs.

## D. Rollback, and why it is weaker than it sounds

Reverting nameservers at the registrar is bounded by TTLs nobody controls, and by
more than one of them:

```
$ dig NS hill90.com @a.gtld-servers.net +noall +authority
hill90.com.  172800  IN  NS  ns1.dns-parking.com.      # parent (.com): 48h

$ dig NS hill90.com @1.1.1.1 +noall +answer
hill90.com.   86400  IN  NS  ns1.dns-parking.com.      # what resolvers serve: 24h
```

**86400 is usually the number that matters, not 172800.** Both child zones
publish an 86400 NS RRset and real recursives return the child value; the
parent's 172800 applies to resolvers priming from the gTLD servers.

1. Typical resolvers are on a 24-hour clock. Disagreement past ~30 hours is
   anomalous, not something to wait out.
2. Some resolvers are stickier than either number. One that learned
   NS=Cloudflare from the child refreshes by asking *Cloudflare*, which re-serves
   NS=Cloudflare at 86400 — a loop that need never re-consult the reverted
   parent.
3. Negative caching differs: Hostinger SOA minimum 600, Cloudflare 1800. An
   NXDOMAIN learned from Cloudflare persists three times longer than expected.

Registrar publication delay is **not measured**. Do not assume minutes.

**Plainly: a revert is one edit, and completes over roughly a day for most of the
internet, up to two for some, and indefinitely for a stubborn minority.** Anyone
calling this cutover easily reversible is wrong.

The real protections, in order of how much work they do: the pre-delegation diff
(Step 5); the Hostinger zone staying untouched so reverting is one registrar
edit; and SSH not depending on public DNS at all (Step 0).

## E. What the zone verification proves

It proves the destination zone is a faithful copy of the source. That is all.

It is **not** evidence that mail survives. Only Step 9 settles that. It is also a
spot-check of known names, not an enumeration — AXFR is refused by both
providers, so nothing here can detect a record present at Hostinger and missing
from Cloudflare unless that name is in Step 5's list.

## F. Known issues carried forward

- **`admin`, `litellm`, `storage` have no Traefik router** and never issue
  certificates. Filed as **#538**. Their `_acme-challenge` TXT records are
  archaeology from services that no longer exist, not evidence of failed
  validation. `storage` is the one that matters: if the object store is restored
  it needs a router and a first issuance watched on staging.
- **`infra/dns/hill90.com.json` describes 7 records against a 32-record zone,**
  and `tests/scripts/hostinger.bats:95` asserts six live hostnames must be
  *absent* from it, so correcting the file turns the suite red. The tests check
  the repo's two descriptions against each other, never against live DNS. Do not
  fix during a cutover.
