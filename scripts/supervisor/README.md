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
- GitHub is the canonical external sensor. A GitHub timeout or failure leaves
  its previous baseline intact, is reported in tick output, and gates lane
  observations and notifications until a successful collection reconciles it.
- Each Git, GitHub, and tmux subprocess has a bounded timeout. The LaunchAgent
  sets an explicit Homebrew-aware `PATH`, rather than relying on an interactive
  shell environment.

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

Do not run this service alongside the retired v4 supervisor. `service.sh`
checks both v4 LaunchAgents (`com.hill90.codex-supervisor` and its `-awake`
companion) plus v4's enabled marker before starting v5. Use its explicit
`cutover` command to stop v4 first. Rollback refuses to restart v4 until v5 has
no open tasks or unacknowledged events, then verifies v4 can read canonical
state and archives v4's old delivery cursor so it takes a fresh snapshot.

`install.sh` installs the reviewed files without starting them.

## Retention

The ledger is an audit and recovery record, not a cache: results, event
payloads, and snapshots have no automatic deletion policy. Back up the state
directory before any explicit archival or deletion decision. Launchd stdout and
stderr logs are operational diagnostics and should be rotated by the host's
normal log-retention policy; never use log deletion as ledger cleanup.
