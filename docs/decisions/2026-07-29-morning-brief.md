# Morning brief — 2026-07-29

> ## Read this first: the client secret is repaired, and this is greenfield
>
> **Two things changed after this brief was first written, and both change what
> you do.**
>
> **1. The `hill90-ui` client secret is fixed.** Repaired ~23:50 UTC on
> 2026-07-29; Keycloak and the store now agree — both 64 characters, matching
> hash, verified 2026-07-30 00:15 UTC. `api`, `mcp` and `ui` have since been
> deployed from the pipeline, all green.
>
> **Client authentication now succeeds. That is not the same as login working.**
> No human has completed a sign-in. The distinction is load-bearing and cost the
> estate a night: a browser was driven to the login form and stopped there, which
> proved the redirect chain and never exercised the exchange behind it. Reachable
> was not working; authenticating is not signing in either.
>
> **2. This is a greenfield deployment, not a migration.** hill90-app reached the
> VPS for the first time on 2026-07-29. The only accounts in realm `hill90` are
> `jon` and `hill90admin`, created hours ago with temporary passwords, and since
> login never worked they have never been used. **There is no accumulated state.**
>
> Anything describing export, import, rollback or cutover is the wrong frame.
> What remains is *configuration of a greenfield deployment*. The realm export and
> the database backup are a **safety net**, not steps in a process.

**State verified against the running host at 08:03 UTC.** Nothing is *degraded* —
every container is healthy and every surface answers. But see the box above: one
thing has never worked, and it was believed to work.

**On the Keycloak migration, everything up to your decision is done and
rehearsed.** The backup restores. The export was taken against a live
`app-keycloak` — no downtime — and verified. The import was rehearsed into a
throwaway and works: all three client secrets present, password hashes intact,
the role mapper survives — kept as a **safety net**, not as a step in a process.
See §0 for the principle the remaining decisions follow from.

Read §0 and §1 and stop if that is all you have time for. §4 records what is
already done. Earlier versions described a four-step sequence you had to run;
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

## 0. The governing principle

**The platform provides identity, data and storage. Tenants consume them.**

Every decision below follows from that one sentence, and it was in the original
brief before this work drifted away from it. Where a question looks open, check it
against this first — most of them answer themselves.

---

## 1. Decisions — three settled, one open

Three of these were recorded in earlier versions of this document as open. They
are not, and describing them as open was the error: it framed settled direction
as undecided and invited re-litigation.

### 1.1 Keycloak — DECIDED: one Keycloak, one realm, the existing `platform`

**One Keycloak, and the app's clients go into the existing `platform` realm.** Not
a new `hill90` realm.

The reasoning is an Entra analogy: you do not create a second tenant for one
organisation. One directory, controlled with roles and groups — infra-versus-app
is a matter of role and client assignment inside it, not a separate namespace.

Earlier versions of this document said *"one Keycloak does not mean one realm"*
and preserved it deliberately. That was wrong and has been removed everywhere. It
framed a settled question as open.

**One concrete thing to handle during the work.** Two places in the app fall back
to `https://auth.hill90.com/realms/hill90` when `KEYCLOAK_ISSUER` is unset:

```
services/api/src/middleware/keycloak-config.ts:15   FALLBACK_ISSUER
services/mcp/app/main.py:17                         os.environ.get(..., default)
```

With the target being `platform` rather than `hill90`, those fallbacks stay wrong
and therefore stay loud, which is the safe direction. Deleting them is still
worthwhile so a blank issuer fails immediately rather than pointing at a realm
that does not exist.

### 1.2 Postgres — DECIDED: `app-postgres` goes

The app consumes the platform's Postgres. An earlier version recorded this as
"two today, no decision recorded" on the grounds that under-claiming was safer.
That was too conservative.

**The complication, which is real and is not the Keycloak steps repeated.**
Hill90's Postgres asserts *platform-only databases* — a check written to fail if
application databases appear there. Consolidating data means that boundary has to
be revisited deliberately, not worked around.

> **Amended 2026-07-30 — the complication is now handled, and the move is not.**
> Hill90 gained `scripts/provision-tenant-db.sh`: a least-privilege tenant role,
> tenant-owned databases, and `PUBLIC` revoked so a tenant cannot open `keycloak`.
> The check now asserts **tenant isolation** and still fails on an application
> database owned by the platform role. Two corrections to the paragraph above:
> that check is a **local dev check**, not production enforcement, and nothing in
> the deploy path consults it. See
> [tenant-databases-on-platform-postgres.md](tenant-databases-on-platform-postgres.md).
>
> What is left is the move itself: point the app at the platform, migrate nothing
> (this is greenfield), and only then retire `app-postgres`. One thing found while
> proving it will bite during that work — a least-privilege tenant cannot install
> `uuid-ossp` or `vector`, which the app's migrations create, so the platform
> installs them. It works today only because the app's `DB_USER` is a superuser in
> its own Postgres.

### 1.3 MinIO — OPEN, and the state is reversed

This one genuinely is undecided, and it is the mirror image of the other two:
**only `app-minio` exists. There is no platform MinIO.** So the question is not
whether a duplicate collapses — it is whether storage **moves up into the
platform**, which the governing principle above suggests it should.

Never addressed until now. No work has been done on it.

### 1.4 Does `hill90-app` go public?

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

### 1.5 Publish the documentation site refresh?

**Publish `docs/mintlify-rescope`. It is the only staged branch** — three
superseded ones have been deleted so the wrong one cannot be picked by name.

It carries everything: eight healthy stacks, the passed detachment test, the proven
restore, **and** this document's re-scope — the governing principle, one realm in
`platform`, Postgres decided, storage open, greenfield rather than migration, and
the current auth position (client authentication works, sign-in unproven).

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

**Also proven, as of 2026-07-30 00:15 UTC:** the `hill90-ui` client secret in
Keycloak and in the store agree, and **client authentication succeeds**. Verified
by control experiment rather than by a status code, because the status code alone
could not tell the two cases apart — both return HTTP 401:

```
correct secret -> "Client not enabled to retrieve service account"
                  (the client authenticated; that grant is simply not permitted — benign)
wrong secret   -> "Invalid client or Invalid client credentials"
                  (the error that was in app-ui's log)
```

**Not proven:** that a human can sign in. Client authentication succeeding is a
different claim, and nobody has completed a sign-in. And no agent has ever run
end to end.

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
- **A deploy guard was added**, and both checkouts now carry it (§4).

---

## 4. What is already done, and what is left

**Steps 1 to 3 of the sequence in earlier versions of this document are complete.**
Nothing in this section is waiting on you.

- **The client secret is repaired** (~23:50 UTC, 2026-07-29) and verified.
- **Both VPS checkouts are pulled and current** — 0 commits behind, both trees
  clean, and `scripts/preflight-checkout.sh` present on both, confirmed
  2026-07-30 00:15 UTC. The bootstrap problem is closed.
- **`api`, `mcp` and `ui` are deployed** from the pipeline, all green.
  `KEYCLOAK_JWKS_URI` is gone from `app-api`'s environment and now derives from
  `KEYCLOAK_ISSUER=https://app-auth.hill90.com/realms/hill90`.

**What is left is the re-scoped configuration work**, and pane 1 is producing that
plan. Do not start from this document — it is deliberately not described here, so
there is one plan rather than two.

The one thing still unproven is a completed human sign-in. That is the acceptance
test, and it is now runnable: `testuser01` exists in realm `hill90` with a
non-temporary password, encrypted at
`hill90-app/infra/secrets/test-accounts.enc.env`.

### Reference — the pull, now completed

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

Completed — `api`, `mcp` and `ui` are deployed and green.

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

**The acceptance test is now runnable** — the client secret is repaired, so there
is finally a path to a successful sign-in to record. Running it is how you learn
whether login works, rather than inferring it from a container being healthy or
from client authentication succeeding. Both of those have been true while login
was broken.

---

## 5. Known-open

Nothing here is blocking, and nothing here is a surprise waiting to happen.

- **Both checkouts are current** — 0 commits behind, both trees clean, verified
  2026-07-30 00:15 UTC. Earlier versions of this document recorded them 14 and 21
  behind; they have since been pulled. Counts move with every merge, so measure
  rather than trust them. The
  tenant now has a dirty-tree guard (#35), and both checkouts have been pulled
  (§4). The analysis is in
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
