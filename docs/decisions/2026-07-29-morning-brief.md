# Morning brief — 2026-07-29

**State verified against the running host at 08:03 UTC.** Nothing is broken and
nothing is degraded. The application is deployed and healthy, and for the first
time it has a backup that has actually been restored.

**One thing is blocked**, and it is a two-command fix — see §3.

**On the Keycloak migration you are no longer at step 0.** The backup exists and
has been restored; the realm export exists and has been verified; the export was
performed against a live `app-keycloak`, so the no-downtime finding is proven by
execution rather than argument. The only thing between you and the next step is
your realm decision (§1.1).

Read the first section and stop if that is all you have time for — **except for
two commands**: both VPS checkouts need pulling before anything deploys. That is
[§3](#3-do-this-first--two-checkouts-need-pulling-before-anything-deploys).
Everything else below is either already safe or already recorded.

```
23 containers running · 0 unhealthy · Hill90 baseline exactly 13 · app 10
(container counts and health, 08:03 UTC · drift counts, 08:17 UTC)
hill90.com 200 · www.hill90.com 200 · app-auth.hill90.com 302
traefik 401 · grafana 302 · vault 307 · storage 200 · portainer 200   (no 403 anywhere)
```

---

## 1. Decisions waiting on you

Four. None is urgent in the sense that something breaks if you leave it, but the
first two block work that is otherwise ready.

### 1.1 Which realm does the consolidated Keycloak use?

You decided there will be **one** Keycloak and that the app stops shipping its
own. You have not decided whether the app's clients land in a **new `hill90`
realm on the platform Keycloak**, or in the **existing `platform` realm**.
**One Keycloak does not mean one realm.** No migration has started, and the
platform Keycloak has no `hill90` realm today.

**The concrete factor, and it points one way.** Two places in the app code fall
back to `https://auth.hill90.com/realms/hill90` when `KEYCLOAK_ISSUER` is unset:

```
services/api/src/middleware/keycloak-config.ts:15   FALLBACK_ISSUER
services/mcp/app/main.py:17                         os.environ.get(..., default)
```

That realm returns **404** on the platform Keycloak today, so a blank issuer
fails loudly. **If the consolidated realm is named `hill90`, that fallback
silently becomes correct** — and from then on a blank issuer is indistinguishable
from working configuration, permanently. Naming it something else, or deleting
the two fallbacks first, keeps the failure loud.

This is a factor, not a recommendation. Either answer is workable.

**Migration step 1 is done — the realm export exists and is verified.** Performed
2026-07-29 08:48 UTC with `app-keycloak` left running, which proves the
no-downtime finding by execution:

```
/opt/hill90/backups/app-realm/20260729_084747/hill90-realm.json
83,970 bytes · -rw------- deploy:deploy · directory drwx------ deploy:deploy
realm hill90 · 2 users, both carrying credentials · 3 clients carrying secrets
5 realm roles · 2 realm_roles protocol mappers
```

Credentials present is what makes it a **restore** rather than a re-creation;
client secrets present are why it beats the `pg_dump`, which cannot carry them.

**That file contains credential material. Do not copy it into a repository**, and
do not move it off the box without deciding where it may live. It is
`0600 deploy:deploy` in a `0700` directory and should stay that way.

**The import is untested.** Rehearsing it — importing into a throwaway, exporting
again, and confirming the hashes and all three client secrets come back
identical — is checklist item 4 in the app's migration runbook and is still open.
Verified export, unverified import.

**The migration needs no downtime.** `kc.sh export` does not need *this*
Keycloak stopped — it needs *an* exporter with database access, so a throwaway
sidecar exports against the live database. This was proven by doing it (see
below), not argued.

That removes the main reason to postpone this to a quiet evening — the export
itself costs nothing. **The `pg_dump` is not a substitute:** only a `kc.sh export`
artifact carries `clients[].secret`, so a database dump alone cannot reconstitute
the client secrets.

### 1.2 Does `hill90-app` go public?

A full-history secret scan came back clean: 2328 blobs across 12 refs, 598
commits. `infra/secrets/prod.enc.env` has exactly one blob version and was
encrypted from creation. No private key, `.env`, JWT, bcrypt hash or credential
was ever committed. The VPS tailnet address and SSH alias were redacted from four
documents beforehand.

**One residual that cannot be closed from here:** if a branch was force-pushed
before the auditing clone existed, pre-rewrite blobs may still be retained on
GitHub's side and addressable by SHA. Rated low — the likeliest carrier, the
secrets store, has no plaintext ancestor to have been rewritten away.

Irreversible in the way that matters: once indexed, flipping it back does not
unring it. Your call alone.

### 1.3 Does Postgres follow Keycloak?

**Deliberately not decided, and not the same call.** Two Postgres instances run
today on separate volumes. Consolidating identity and consolidating data are
different moves: Hill90's own health check asserts *platform-only databases* and
is written to fail if application databases appear there. That boundary was
designed on purpose.

Nothing is blocked by leaving this open.

### 1.4 Publish the documentation site refresh?

A refresh of [docs.hill90.com](https://docs.hill90.com) is **written, reviewed and
held unpublished**, on branch `docs/post-deploy-refresh` in `hill90-docs`. It
corrects the site to eight healthy stacks, the passed detachment test, the proven
restore, and the Keycloak decision in both halves.

It is held because the site is the most public surface in the estate and because
its *merged-but-not-deployed* list will need one touch-up after you deploy
(§4.1). Publishing after that deploy costs nothing and lands accurate.

---

## 2. What changed overnight

- **All eight application stacks are deployed and healthy.**
- **The detachment test passed.** The app was torn down to a single container and
  redeployed: Hill90 returned to exactly 13 containers with all four shared
  networks intact, the app came back to 10 healthy containers, `hill90.com`
  answered 200, and both user accounts survived. Tenancy is proven, not asserted.
- **Backups work, and the restore is proven.** Two defects were fixed: the
  nightly SQL dump had been failing silently, and the application's database had
  never been backed up at all. A dump that cannot be taken is now fatal rather
  than a warning. The application dump was restored into a throwaway container
  and both accounts came back with their correct roles — the first restore this
  estate has performed. Mechanism and artifact sizes:
  [deployment runbook § Backups](../runbooks/deployment.md#backups).
- **Application tests now run on every pull request** — six suites, all passing.
- **A deploy guard was added**, which is why §3 exists.

---

## 3. Do this first — two checkouts need pulling before anything deploys

**Both repositories are blocked until you run these.** Not tidiness; hard blocks,
and they will be the first thing you hit.

```bash
ssh deploy@<vps> 'cd /opt/hill90/app && git pull'   # Hill90
ssh deploy@<vps> 'cd /opt/hill90-app && git pull'   # the app
```

**Why they are blocked.** Every deploy path in both repositories now runs a
guard script over SSH, and neither checkout has it yet. The script ships *in* the
repository, so it only reaches the box after one deploy that includes it — a
chicken-and-egg the guard created. One pull each resolves it permanently.

If you deploy without pulling, both now **tell you exactly this** and name the
fix; neither fails mysteriously any more (Hill90 #570, hill90-app #35).

**Both pulls are safe.** Both working trees are **clean** (0 modifications,
08:58 UTC), so nothing is destroyed, and no pending file in either touches a
bind-mounted, watched directory, so nothing live-reloads.

**Backups are unaffected either way.** The backup fix is already on the box
(`b50b3a1`) and the 03:00 cron runs `backup-all`, which includes `app-db`.

---

## 4. Safe to do

### 4.1 Deploy the merged-but-undeployed application changes

`/opt/hill90-app` was at `f882158` and `main` at `fb90223` at 08:17 UTC —
**at least 15 commits merged and not deployed**, everything from #21 onward. The running containers still carry the previous configuration.

Treat every count in this document as a floor, not a total. Three PRs landed
while it was being written, so the real gap is this or larger. Check it yourself:

```bash
ssh deploy@<vps> 'cd /opt/hill90-app && git fetch -q && git rev-list --count HEAD..origin/main'
```

```bash
gh workflow run "Manual Deploy App (Prod)" -f service=<stack> -f dry_run=true
```

Use `dry_run=true` first; it runs every guard and stops before changing anything.

**What actually changes at runtime if you do:** almost nothing user-visible. One
environment variable disappears from `api` and `mcp`, one appears on `ui`, and
`app-keycloak` is a byte-for-byte no-op that will not even be recreated. The one
change with teeth is that token validation moves from an internal URL to the
public issuer through Traefik — verified working from inside both containers, but
it makes the edge a dependency of authentication. Per-stack detail, measured by
diffing the rendered config against the running containers:
[pre-deploy impact](2026-07-29-pre-deploy-impact.md).

**One thing to know before deploying rather than after.** One of these commits
moves API token validation from an internal URL onto the **public issuer path
through Traefik**.
It was verified reachable from inside both containers, so it works — but it makes
the edge a dependency of authentication: if Traefik is down, authentication
fails, which was not true before. That is a deliberate tradeoff for making
the issuer impossible to diverge; it is recorded in the app's runbook, and it is
worth knowing you are taking it.

---

## 5. Known-open

Nothing here is blocking, and nothing here is a surprise waiting to happen.

- **The tenant checkout was at least 15 commits behind** with a clean tree
  (`/opt/hill90-app` at `f882158`, measured 08:17 UTC). It now *does* have a
  dirty-tree guard (#35) — which is why it needs the pull in §3. The analysis is in
  [tenant-checkout-hazard.md](tenant-checkout-hazard.md) — the tenant has the
  lost-edits hazard but **not** the live-config hazard, because nothing in it is
  bind-mounted *and* watched.
- **`admin.hill90.com` resolves to the tailnet address and returns nothing.** No
  router matches it and no container serves it — stale DNS pointing at an
  absence, not a fault. Verified: zero Traefik routers reference it.
- **Hill90 #556 and #559 are open and conflicting** and need a rebase before they
  can land. #556 restores MinIO as a platform service; #559 scrapes the tenant's
  database.
- **No agent has been run end to end on the VPS.** Healthy containers and
  answered routes are not an exercised application. This is the largest untested
  surface remaining.
- **The application realm ships with zero users.** The two accounts that exist
  were created by hand and live only in the application's database. Rebuilding
  that database would lock everyone out — now recoverable, but only because a
  verified backup exists. Nothing seeds an account from the repository, and
  fixing that means deciding what credential a committed realm import carries.

---

*Prepared 2026-07-29 08:17 UTC, verified against the running host and the
repositories at that time. Re-check anything here before acting on it.*
