# Hill90 portable supervisor

This directory holds the durable coordination core for Hill90's tmux agent
lanes. tmux persists interactive Claude and Codex terminals; it is not the
task database or normal result transport.

## Contract

- SQLite provides one transactional task/event ledger under
  `~/.local/state/hill90-supervisor` (mode `0700`).
- A logical lane is bound to a physical tmux pane incarnation with a random
  nonce, tmux server/session identity, harness, command, and repository path.
- A lane has at most one nonterminal task. The prompt contains the stable task
  ID and the commands that accept and complete that task.
- Completion results are immutable, limited to 64 KiB, hashed, and published
  with a deterministic `completion:<task-id>` event in the same database
  transaction as the terminal task transition.
- An outstanding delivered task observed idle produces the persistent
  `attention:<task-id>` event. It cannot be acknowledged until the task is
  completed, failed, or cancelled, and notified events retry after their
  deadline.
- Architecture notifications contain event IDs and result paths—not tmux
  scrollback or broad repository snapshots—and are marked notified only after
  the architecture harness is genuinely active.
- Codex and Claude use different terminal classifiers but the same ledger
  schema and lifecycle.

## Commands

```bash
hill90-supervisor register --lane architecture --target %19 \
  --harness codex --repo /Users/jon/source/repos/Personal/Hill90

hill90-supervisor register --lane infra-claude --target %8 \
  --harness claude --repo /Users/jon/source/repos/Personal/Hill90

hill90-supervisor assign --lane infra-worker --task h-123-review \
  --summary 'Review PR 123 at its exact head; do not edit or merge.'

hill90-supervisor tick
hill90-supervisor status
```

Workers run the task-bound `accept` and `complete` commands included in their
brief. Architecture acknowledges accepted events explicitly. The periodic tick
only observes registered lanes and delivers due ledger events.

## Verification

```bash
python3 -m unittest discover -s scripts/supervisor/tests -v
python3 -m py_compile scripts/supervisor/*.py
```

Do not run this service alongside the retired v4 supervisor. Cutover and
rollback must prove that only one prompt writer is loaded before enabling the
other.

`install.sh` installs the reviewed files without starting them. `service.sh`
refuses to start v5 while the v4 LaunchAgent or enabled marker exists, and its
rollback path stops v5 before invoking the retained v4 control script.
