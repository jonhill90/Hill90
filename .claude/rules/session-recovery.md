---
description: Enforces context-collapse recovery protocol
globs:
alwaysApply: true
---

After any context compaction or collapse, you MUST:

1. Restate the current task and active workflow from the most recent summary.
2. Run primer (`/primer`) before making any changes or running commands.
3. Do not assume prior tool results are still valid — re-read key files if needed.

Never resume editing or running commands without completing steps 1-2 first.
