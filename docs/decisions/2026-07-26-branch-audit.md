# Remote branch audit — 2026-07-26

**Status:** audit only. No branches were deleted, and this document deletes none.
**Scope:** the 168 remote branches on `jonhill90/Hill90` besides `main`.
**Cleanup script:** [`scripts/cleanup-branches.sh`](../../scripts/cleanup-branches.sh)

---

## The finding that matters

**Nine branches hold ten files that exist in no preserved history — not on
`main`, not at the `archive/app-stack-final` tag, and not in `hill90-app`.**

Deleting those nine would destroy roughly **1,059 lines** permanently. None of it
is infrastructure the running host needs, and none of it is large, but the
premise that everything is preserved twice over is **not true for these**.

| File | Lines | On branch(es) |
|---|---|---|
| `.github/skills/tmux/SKILL.md` | 428 | `enhance/tmux-supervisor-lane` |
| `services/ui/src/app/admin/rbac/RbacClient.tsx` | 170 | `feat/rbac-page` |
| `services/ui/src/components/KeyboardShortcuts.tsx` | 130 | `feat/keyboard-shortcuts`, `feat/breadcrumbs`, `feat/error-boundary` |
| `services/ui/src/components/Breadcrumbs.tsx` | 89 | `feat/breadcrumbs`, `feat/error-boundary` |
| `services/ui/src/__tests__/RbacClient.test.tsx` | 83 | `feat/rbac-page` |
| `services/ui/src/components/ErrorBoundary.tsx` | 61 | `feat/error-boundary` |
| `services/ui/src/utils/api-proxy-multipart.ts` | 45 | `fix/storage-upload`, `fix/storage-upload-v2` |
| `services/ui/src/app/admin/rbac/page.tsx` | 30 | `feat/rbac-page` |
| `platform/vault/policies/policy-secrets-admin.hcl` | 20 | `feat/live-browser-view` |
| `services/api/src/db/migrations/052_add_chat_archived.sql` | 3 | `feat/chat-archive` |

The largest single item is the **tmux supervisor skill** (428 lines) — a skill
document, not application code, and the only one of these that would plausibly
still be useful now that the app is gone.

Everything else is UI work for a shelved application: an RBAC admin page, an
error boundary, breadcrumbs, a keyboard-shortcuts component, a multipart upload
proxy, one vault policy, one migration.

**This changes nothing about whether to delete them — only about doing it
knowingly.** If Jon's answer is "the app is shelved, none of that matters", these
branches are as deletable as the rest. The point is that it is a decision rather
than an assumption.

---

## Why the archive tag does not cover this

Worth stating plainly, because it is the reason the finding exists:

`archive/app-stack-final` points at `f03f12d`, which **is an ancestor of `main`**.
The tag preserves the state of the mainline at the moment before the strip — it
does not preserve anything that never reached the mainline. `hill90-app` was
extracted from that same commit, so it has the same blind spot.

Both archives are complete for *merged* work and empty for *unmerged* work. That
is the correct expectation to hold about them from now on.

---

## Categories

168 branches, and every one lands in exactly one bucket.

| Category | Count | What it means | Safe to delete |
|---|---|---|---|
| **A1** — no differences from `main` at all | 8 | Ancestors of `main`, or identical trees | Yes |
| **A2** — every file version preserved | 136 | Squash-merged; every blob on the branch exists in a preserved history | Yes |
| **B** — superseded work-in-progress only | 15 | Every *path* exists elsewhere; only intermediate file versions are unique | Yes, with the note below |
| **C** — holds files preserved nowhere | 9 | Contains at least one file path absent from every archive | **Read the table above first** |

### A1 — no differences (8)

```
enhance/activity-icons     feat/agent-journal-api     feat/theme-context
enhance/home-page          feat/notifications-bell    fix/chat-viewport-scroll
feat/agent-bulk-delete     feat/workflows-page
```

### A2 — fully preserved (136)

The bulk. Every one had a merged PR and every file version on the branch is
present somewhere in `main`'s history or `hill90-app`. Listed in the cleanup
script rather than here.

### B — superseded work-in-progress (15)

```
enhance/chat-delete-confirm   feat/agent-workspace-files   feat/chat-slash-commands
enhance/usage-page-ux         feat/autonomy-level          feat/connection-health
feat/agent-journal            feat/autonomy-level-v2       feat/skill-dependency-view
feat/agent-runtime-metrics    feat/browser-take-control    fix/browser-event-loop-v2
feat/agent-summary-report     feat/chat-search             sync/vault-to-sops-20260329
```

These contain file *versions* that exist nowhere else, but every file *path* on
them is present in a preserved history — meaning the feature landed and what is
unique here is an earlier draft of a file that merged in revised form. Verified
by spot-check: `feat/agent-journal`'s migration
(`055_create_agent_journal.sql`), `feat/browser-take-control`'s `takeControl`
handling and `feat/skill-dependency-view`'s dependency route are all present in
both `f03f12d` and `hill90-app`.

Deleting these loses review-iteration history and nothing else.

### C — holds unpreserved files (9)

```
enhance/tmux-supervisor-lane   feat/error-boundary        fix/storage-upload
feat/breadcrumbs               feat/keyboard-shortcuts    fix/storage-upload-v2
feat/chat-archive              feat/live-browser-view     feat/rbac-page
```

See the table at the top. All nine had a PR that was **closed without merging**,
or no PR at all — so this is unfinished work, not lost work.

---

## Recommendation

**Delete A and B — 159 branches — and decide C separately.**

That clears 95% of the debris with no possibility of losing anything, and leaves
a nine-branch question that takes a minute to answer.

For C, the options are:

1. **Delete them too.** Defensible: the app is shelved and none of this is
   infrastructure. One command, in the script, commented out.
2. **Salvage the tmux skill first.** It is 428 lines of skill documentation, not
   app code, and it is the only item with obvious ongoing value. Cherry-pick the
   file, then delete.
3. **Tag them before deleting.** `git tag archive/unmerged-<branch>` on each of
   the nine keeps them reachable forever at zero cost, and makes the deletion
   reversible. The script offers this as the default.

Option 3 costs nine tags and closes the question permanently. That is what the
script does unless you tell it otherwise.

---

## How this was determined

Method matters here, because two obvious approaches give wrong answers:

- **Ancestry (`git merge-base --is-ancestor`) is wrong.** Only 7 branches are
  ancestors of `main`, because squash-merging leaves the branch's own commits
  unreachable even though the work landed. Judging by ancestry alone would
  condemn 162 branches as "unmerged".
- **Comparing branch content to `main` is wrong.** The strip deleted `services/`,
  so every app-era branch differs from `main` by definition. That test flagged
  160 branches and means nothing.
- **Matching commit subjects is wrong.** It produced false positives on
  `feat/agent-journal`, `feat/browser-take-control` and
  `feat/skill-dependency-view` — all of which had genuinely landed, under
  different squash-commit titles.

What actually works: index **every blob SHA that has ever existed** in
`origin/main`'s full history, `f03f12d`'s full history and `hill90-app`'s full
history — 3,635 distinct blobs — then check each branch's files against it.
Blob identity is content identity, so it is immune to rewritten SHAs, retitled
squashes and filtered history.

A path-level check on top of that separates "unique draft of a file that landed"
(category B) from "file that never landed at all" (category C).

Reproduce with [`scripts/cleanup-branches.sh audit`](../../scripts/cleanup-branches.sh).
