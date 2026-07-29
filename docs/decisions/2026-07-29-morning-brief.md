# Morning brief — 2026-07-29

**State verified against the running host at 08:03 UTC.** Nothing is broken.
Nothing is waiting on you to unblock work. The application is deployed and
healthy, and for the first time it has a backup that has actually been restored.

Read the first section and stop if that is all you have time for. Everything
below it is either already safe or already recorded.

```
23 containers running · 0 unhealthy · Hill90 baseline exactly 13 · app 10
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
(§3.2). Publishing after that deploy costs nothing and lands accurate.

---

## 2. What changed overnight

- **All eight application stacks are deployed and healthy.** Previously six; `mcp`
  and `minio` had never been deployed.
- **The detachment test passed.** The app was torn down to a single container and
  redeployed: Hill90 returned to exactly 13 containers with all four shared
  networks intact, the app came back to 10 healthy containers, `hill90.com`
  answered 200, and both user accounts survived. Tenancy is proven, not asserted.
- **Backups were silently broken and are now fixed and proven.** Under cron,
  `PATH` lacks `/usr/local/bin` where `sops` lives, so the secrets decrypt was
  *command not found*, the SQL dump was skipped with a warning, the volume tar
  still ran, and the job exited 0. Three consecutive nightly backups held a tar
  and no dump. Separately, the application's database had **never** been backed
  up by anything. Both fixed; a dump that cannot be taken is now fatal.
- **The restore works.** The application dump was restored into a throwaway
  container and both accounts came back with their correct realm roles. First
  restore this estate has performed.
- **Application tests now run on every pull request** — six suites, all passing.
  Previously only shell tests gated a merge.
- **A deploy guard was added** (`scripts/preflight-checkout.sh`): a dirty VPS
  checkout now prints its full diff and refuses, instead of `git reset --hard`
  destroying it silently. This was written after exactly that happened.

Current backups:

```
/opt/hill90/backups/db/20260729_065934/      database.sql        322,299 bytes
/opt/hill90/backups/app-db/20260729_065944/  app-database.sql    532,513 bytes
                                             app-postgres-data.tar.gz  17,347,196
```

Both SQL dumps non-empty, verified 08:03 UTC.

---

## 3. Safe to do

### 3.1 Pull the Hill90 checkout on the VPS

```bash
ssh deploy@<vps> 'cd /opt/hill90/app && git pull'
```

**Why it is safe:** 3 commits behind, working tree **clean** (0 modifications),
and **zero** of the pending files touch `platform/edge/dynamic` — the only
bind-mounted directory Traefik watches. Nothing live-reloads as a result. The
pending files are four workflows, two documents, the preflight script and its
tests.

**Why bother:** it installs `scripts/preflight-checkout.sh` where it actually
runs. Until then the guard exists in the repository but not on the box, and the
first deploy after it lands will halt at exit 127 rather than run unguarded —
safe, but surprising. This is a one-time bootstrap cost.

**Tonight's backups are not affected either way.** The backup fix is already on
the box (`b50b3a1`), the cron entry runs `backup-all`, and that now includes
`app-db`. The 03:00 run will produce both dumps with the fail-closed behaviour.

### 3.2 Deploy the merged-but-undeployed application changes

`/opt/hill90-app` is at `f882158`; `main` is `a6db125`. **13 commits are merged
and not deployed** — everything from #21 to #33. The running containers still
carry the previous configuration.

```bash
gh workflow run "Manual Deploy App (Prod)" -f service=<stack> -f dry_run=true
```

Use `dry_run=true` first; it runs every guard and stops before changing anything.

**One thing to know before deploying rather than after.** #26 moves API token
validation from an internal URL onto the **public issuer path through Traefik**.
It was verified reachable from inside both containers, so it works — but it makes
the edge a dependency of authentication. If Traefik is down, authentication fails
in a way it previously would not have. That is a deliberate tradeoff for making
the issuer impossible to diverge; it is recorded in the app's runbook, and it is
worth knowing you are taking it.

---

## 4. Known-open

Nothing here is blocking, and nothing here is a surprise waiting to happen.

- **The tenant checkout is 13 commits behind** with a clean tree
  (`/opt/hill90-app` at `f882158`). It also has no equivalent of the dirty-tree
  guard. The analysis is in
  [tenant-checkout-hazard.md](tenant-checkout-hazard.md) — the tenant has the
  lost-edits hazard but **not** the live-config hazard, because nothing in it is
  bind-mounted *and* watched.
- **`admin.hill90.com` resolves to the tailnet address and returns nothing.** No
  router matches it and no container serves it — stale DNS pointing at an
  absence, not a fault. Verified: zero Traefik routers reference it.
- **Hill90 #556 and #559 are both open and now conflicting**, having been
  overtaken by tonight's merges. #556 restores MinIO as a platform service; #559
  scrapes the tenant's database. Both need a rebase before they can land, and
  #556 in particular will re-open the MinIO naming question.
- **No agent has been run end to end on the VPS.** Healthy containers and
  answered routes are not an exercised application. This is the largest untested
  surface remaining.
- **The application realm ships with zero users.** The two accounts that exist
  were created by hand and live only in the application's database. Rebuilding
  that database would lock everyone out — now recoverable, but only because a
  verified backup exists. Nothing seeds an account from the repository, and
  fixing that means deciding what credential a committed realm import carries.

---

*Prepared 2026-07-29 08:05 UTC. Every state claim in this document was verified
against the running host or the repositories at that time, not carried forward
from earlier in the night. Claims age: re-check before acting on anything here
more than a few hours old.*
