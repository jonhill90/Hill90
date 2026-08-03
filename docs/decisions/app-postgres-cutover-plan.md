# Pointing hill90-app at the platform's Postgres — the change set

**Status: DONE and superseded. Kept as a stub because two documents cite it.**

Planned 2026-07-30, executed 2026-07-31.

## What this said, and why it is wrong now

It opened *"**Nothing has been cut over.** `app-postgres` is running, serving, and
untouched"*. That was true when written and is now false in both halves: the
cutover was performed on 2026-07-31, and the host carries **zero** `app-postgres`
containers. Verified 2026-08-03.

## What actually happened

The tenant's data moved onto the platform Postgres as `hill90_api`, `hill90_akm`
and `hill90_litellm`, owned by role `hill90_app` with `superuser=false`. The
volume and per-table-verified dumps were retained.

The live records are:

- **[tenant-databases-on-platform-postgres.md](tenant-databases-on-platform-postgres.md)**
  — the arrangement as built, and the contract around it
- **hill90-app's `CLAUDE.md`** — carries the settled statement that `app-postgres`
  is gone

The 377 lines of change set that lived here were a pre-execution plan. They
described edits that have since been made, so reading them now describes the
past as though it were pending, which is the specific way a spent plan misleads.
