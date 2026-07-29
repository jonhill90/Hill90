# Morning brief — 2026-07-29

> ## Read this first: production login does not work
>
> **Nobody can sign in to hill90.com, and nobody has been able to since it was
> deployed.** Confirmed 2026-07-29 09:23 UTC. This is not a regression and it
> locks nobody out who was previously in — it has never worked.
>
> The `hill90-ui` client secret Keycloak minted at realm import (**32 chars**)
> is not the one `app-ui` holds (**64 chars**). They are different values, so
> the token exchange fails and `app-ui` logs `CallbackRouteError` →
> `unauthorized_client` / *Invalid client or Invalid client credentials*.
>
> **Cause:** `platform/auth/keycloak/hill90-realm.json` declares its clients with
> **no `secret` field**, so Keycloak generates a random one at import, while SOPS
> carries a value that was never applied. Configuration present, plausible, and
> inert — the same family as every other defect found this week.
>
> **It is deliberately not fixed.** Aligning a client secret is a credential
> operation and it was not going to be done while you were asleep. The repair —
> both options, a recommendation, exact commands and rollback — is prepared in
> hill90-app's migration runbook. Read that rather than improvising.
>
> **Why it went unnoticed, which is the lesson.** A browser was driven to the
> Keycloak login form and deliberately stopped there, to avoid consuming a
> one-time password. That proved the redirect chain — `hill90.com` → `app-auth`,
> PKCE, correct `client_id`, a rendered form — and never exercised the step that
> fails. **Reachable is not working**, and every claim about login in these
> documents rested on the reachable half.

**State verified against the running host at 08:03 UTC.** Nothing is *degraded* —
every container is healthy and every surface answers. But see the box above: one
thing has never worked, and it was believed to work.

**On the Keycloak migration, everything up to your decision is done and
rehearsed.** The backup restores. The export was taken against a live
`app-keycloak` — no downtime — and verified. The import was rehearsed into a
throwaway and works: all three client secrets present, password hashes intact,
the role mapper survives. **The only thing left before step 2 is your realm
decision (§1.1).**

Read §1 and stop if that is all you have time for — **except §4**, which is a
four-step sequence with a real dependency: the client secret must be repaired
before a deploy will even run. Everything else is either already safe or already
recorded.

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

Credentials present is what makes it a **restore** rather than a re-creation.

It beats the `pg_dump` not because the dump lacks the secrets — the dump does
contain them, in the `client` table — but because it is **the only artifact
Keycloak can import**. `--import-realm` consumes a realm JSON; a database dump
can only be restored by replacing a database, which is the destructive path
described below.

**That file contains credential material. Do not copy it into a repository**, and
do not move it off the box without deciding where it may live. It is
`0600 deploy:deploy` in a `0700` directory and should stay that way.

**The import is rehearsed and works** (2026-07-29). Imported into a throwaway
stack: all three client secrets present, password hashes intact, and the
`realm_roles` mapper survives on `hill90-ui` pointing at `realm_roles` with no
competing mapper.

> **Do not use the `pg_dump` as the import vehicle.** It is the obvious
> shortcut — the backup exists, it contains the realm, it looks sufficient — and
> it is destructive. That dump is a whole-cluster restore of a *different*
> Keycloak's database. Its `keycloak` database contains realms `master` and
> `hill90` and **no `platform` realm**, while the platform's `keycloak` database
> holds `master` and `platform`, and `platform` is where the `grafana`,
> `portainer` and `hill90-vault` SSO clients live.
>
> It also does not fail cleanly. The dump carries `CREATE DATABASE keycloak` and
> **no `DROP DATABASE`**, so against an existing database the create fails,
> `psql` continues past the error by default, and the app's realm rows are then
> copied *into the live platform database*. The likely outcome is a partially
> merged identity store rather than a clean overwrite — worse, because it may not
> fail loudly.
>
> The `kc.sh export` artifact is the only valid vehicle. It can be produced from
> the backup if the live realm is ever unavailable.

**The migration needs no downtime.** `kc.sh export` does not need *this*
Keycloak stopped — it needs *an* exporter with database access, so a throwaway
sidecar exports against the live database. This was proven by doing it (see
below), not argued.

That removes the main reason to postpone this to a quiet evening — the export
itself costs nothing. **The `pg_dump` is not a substitute:** only a `kc.sh export`
artifact is importable: Keycloak's `--import-realm` takes a realm JSON, and a
database dump can only be applied by replacing a database.

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

**Not a yes/no any more — publish one specific branch, and not before step 1.**

**Publish `docs/mintlify-login-truth`. Nothing else.**

Three branches were staged in `hill90-docs` during the night, and only the newest
is correct. The two older ones **have been deleted** so the wrong one cannot be
picked by name; they are recorded here so the history is not confusing:

| Branch | When | State |
|---|---|---|
| `docs/post-deploy-refresh` | 07:53 UTC | **Deleted.** Written before the login failure was known. Said the login form was reachable and instructed *"Sign in with your Keycloak credentials"* — an instruction that cannot be followed. |
| `docs/post-deploy-refresh-login` | 09:27 UTC | **Deleted.** Superseded intermediate. It warned about the login on the application overview page only, which was not enough: the quickstart and authentication pages still read as a working flow, and those are the two someone trying to sign in would open. |
| **`docs/mintlify-login-truth`** | **09:52 UTC** | **This is the one.** Every `ai-app` page carries the broken-login finding, the sign-in instruction is corrected, and three pages that named `auth.hill90.com` as the application's identity provider now name `app-auth.hill90.com` — the homelab's is a different realm. |

Both deleted branches were verified to be strict ancestors of the surviving one
before removal: it contains everything they did, and the only lines it drops are
a stale timestamp and the incorrect `auth.hill90.com` references it replaces.
Their commits remain reachable through `docs/mintlify-login-truth`.

All three corrected the site to eight healthy stacks, the passed detachment test,
the proven restore, and the Keycloak decision in both halves.

**Two things before it goes live**, neither large:

1. **Repair the login (§4, step 1) first, or publish knowing the site says login
   is broken.** Either is defensible — the site is accurate in both cases — but
   publishing first and repairing second leaves the site briefly wrong *in the
   reassuring direction*, which is the worse way round.
2. **Touch up the merged-but-not-deployed list after you deploy** (§4, step 3) —
   a one-line edit.

The site is the most public surface in the estate, which is why this is the one
place where publishing something stale costs more than waiting.

---

## 2. What is proven, and what is not

"Deployed is not the same as proven working" turned out to be more right than
anyone intended. Both halves are worth stating plainly.

**Proven, and earned:** it starts; it routes; it serves valid TLS on three
hostnames; it reaches its identity provider and renders a login form; its
database backs up and **restores**, with accounts and roles recovered into a
throwaway; it detaches and reattaches cleanly, leaving the platform at exactly
its 13-container baseline. That list took a night to earn and none of it is in
doubt.

**Not proven:** that a human can sign in. That is now known to be false, not
merely untested — see the box at the top. And no agent has ever run end to end.

## 3. What changed overnight

- **All eight application stacks are deployed and healthy.**
- **The detachment test passed.** The app was torn down to a single container and
  redeployed: Hill90 returned to exactly 13 containers with all four shared
  networks intact, the app came back to 10 healthy containers, `hill90.com`
  answered 200, and both user accounts survived in the database. Tenancy is
  proven, not asserted. Note the limit: accounts surviving is a data claim, not a
  sign-in claim — see the box at the top.
- **Backups work, and the restore is proven.** Two defects were fixed: the
  nightly SQL dump had been failing silently, and the application's database had
  never been backed up at all. A dump that cannot be taken is now fatal rather
  than a warning. The application dump was restored into a throwaway container
  and both accounts came back with their correct roles — the first restore this
  estate has performed. Mechanism and artifact sizes:
  [deployment runbook § Backups](../runbooks/deployment.md#backups).
- **Application tests now run on every pull request** — six suites, all passing.
- **A deploy guard was added**, which is why §4 exists.

---

## 4. The morning sequence — these are ordered, not a list

**Four steps with a real dependency between them.** Doing them out of order means
hitting a wall and working out why, which is what this document exists to
prevent. In particular: **deploying before step 1 will fail**, deliberately.

### Step 1 — repair the Keycloak client secret

Nothing else is worth doing first. Login has never worked (see the box at the
top), and a deploy now **refuses to run** while the secret in the running
Keycloak disagrees with the store — correctly, because deploying with a
mismatched secret reproduces exactly the failure you already have.

Both options, a recommendation, exact commands and rollback are prepared in
hill90-app's `docs/runbooks/one-keycloak-migration.md`. It is a credential
operation; follow it rather than improvising.

### Step 2 — pull both VPS checkouts

```bash
ssh deploy@<vps> 'cd /opt/hill90/app && git status --short && cd /opt/hill90-app && git status --short'
# no output from either = still safe to pull

ssh deploy@<vps> 'cd /opt/hill90/app && git pull'
ssh deploy@<vps> 'cd /opt/hill90-app && git pull'
```

Every deploy path in both repositories runs a guard script that ships *in* the
repository, so it only reaches the box after one pull — a chicken-and-egg the
guard created. Both now say so and name the fix rather than failing obscurely.

**Both pulls were safe as of 10:09 UTC** — both trees clean (0 modifications),
and no pending file in either touches a bind-mounted, watched directory, so
nothing live-reloads.

**If the numbers look bigger than you expected, nothing broke.** The checkouts
were 3 and 13 commits behind when this document was started and were 14 and 21 by
10:09 UTC. That is merge activity overnight, not drift on the host: both working
trees have been clean throughout, and nothing has been deployed. The counts only
ever grow until a deploy runs, which is why the instruction is to measure them
rather than read them here.
**That fact has a short half-life, so run the `git status` above first.** If
either is dirty the pull destroys uncommitted work, and the guard that would have
caught that is precisely what is not installed yet. The precondition for the fix
cannot be assumed by the fix.

**Backups are unaffected either way.** The backup fix is already on the box
(`b50b3a1`) and the 03:00 cron runs `backup-all`, which includes `app-db`.

### Step 3 — deploy

Only now, because the guard blocks it until step 1 is done.

```bash
gh workflow run "Manual Deploy App (Prod)" -f service=<stack> -f dry_run=true
```

`dry_run=true` first; it runs every guard and stops before changing anything.

**At least 21 commits are merged and undeployed as of 2026-07-29 10:09 UTC**, and
that number grows with every merge — it was 13 when this document was started.
Do not act on the figure; measure it:

```bash
ssh deploy@<vps> 'cd /opt/hill90-app && git fetch -q && git rev-list --count HEAD..origin/main'
```

What
actually changes at runtime is small and is measured per stack in
[pre-deploy impact](2026-07-29-pre-deploy-impact.md): one environment variable
disappears from `api` and `mcp`, one appears on `ui`, and `app-keycloak` is a
no-op that will not even be recreated. The one change with teeth moves token
validation onto the public issuer through Traefik, which makes the edge a
dependency of authentication.

Counts move as things merge; check yourself:

```bash
ssh deploy@<vps> 'cd /opt/hill90-app && git fetch -q && git rev-list --count HEAD..origin/main'
```

### Step 4 — confirm the repair actually worked

A `testuser01` account exists in the app realm with a **non-temporary** password,
so it can be used repeatedly without consuming anyone's one-time credential. The
password is encrypted at `hill90-app/infra/secrets/test-accounts.enc.env`,
deliberately separate from `prod.enc.env` because a credential no container reads
would trip the store-keys guard. It decrypts with the host age key.

**The acceptance test is written but cannot be run yet.** It needs a known-good
token to compare against, and no login has ever succeeded, so there is nothing to
record one from. **It becomes runnable the moment step 1 lands** — and running it
is how you find out whether the repair worked, rather than assuming it did
because a container went healthy. That assumption is what produced the current
situation.

---

## 5. Known-open

Nothing here is blocking, and nothing here is a surprise waiting to happen.

- **Both checkouts are well behind and both trees are clean** — at 10:09 UTC,
  `/opt/hill90/app` was 14 commits behind and `/opt/hill90-app` 21, both with 0
  modifications. These counts only grow; measure rather than trust them. The
  tenant now has a dirty-tree guard (#35), which is why it needs the pull in §4,
  step 2. The analysis is in
  [tenant-checkout-hazard.md](tenant-checkout-hazard.md) — the tenant has the
  lost-edits hazard but **not** the live-config hazard, because nothing in it is
  bind-mounted *and* watched.
- **`admin.hill90.com` resolves to the tailnet address and returns nothing.** No
  router matches it and no container serves it — stale DNS pointing at an
  absence, not a fault. Verified: zero Traefik routers reference it.
- **Hill90 #556 and #559 are open and conflicting** and need a rebase before they
  can land. #556 restores MinIO as a platform service; #559 scrapes the tenant's
  database.
- **Nobody has exercised the app, and that gap has now cost something real.**
  Healthy containers and answered routes are not an exercised application — and
  the broken login at the top of this document is the proof. It sat undetected
  for the whole deployment because every check stopped at the last observable
  step before the failure. What is untested is not a formality; it is where the
  defects are. No agent has been run end to end on the VPS, and that remains the
  largest untested surface.
- **`/opt/hill90/agentbox-configs` is unprotected, and empty.** It is
  bind-mounted into `api` and passed to every agent container `api` creates, but
  it sits outside every checkout and outside every backup: 0 references in
  `backup.sh`, 0 matches anywhere under `/opt/hill90/backups`, 0 tracked files in
  the tenant repository. **Today that costs nothing** — verified 09:16 UTC, it
  holds 0 files and has not changed since 14 June. It becomes an unrecoverable
  gap the moment an agent writes its first config there, and nothing would
  announce that it had. Unprotected by design, harmless now, silently
  irreversible on first use.
- **The application realm ships with zero users.** The two accounts that exist
  were created by hand and live only in the application's database. Rebuilding
  that database would lock everyone out — now recoverable, but only because a
  verified backup exists. Nothing seeds an account from the repository, and
  fixing that means deciding what credential a committed realm import carries.

---

## Process note, for whoever runs the next session

Two things worth carrying forward.

**Check what a lane is standing on before merging its base.** Merging as soon as
things went green kept the queue moving, but twice a branch was merged and
deleted while another lane was mid-work stacked on it. It cost only a rebase
here; with a larger change it would have cost more.

**A claim's age is part of the claim.** Every state assertion in this document
carries the time it was measured, because several were overtaken within the hour
— container counts, drift, whether a guard had landed. The habit is cheap and it
caught three claims that had gone stale between being written and being read.

---

*Prepared 2026-07-29, last verified 10:09 UTC against the running host and the
repositories: 23 containers running, 0 unhealthy, Hill90 baseline exactly 13,
both working trees clean, `hill90.com` 200. Re-check anything here before acting
on it — several claims moved within an hour of being written, and the commit
counts move every time something merges.*
