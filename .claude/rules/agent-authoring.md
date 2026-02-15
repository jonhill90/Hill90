---
paths:
  - ".github/agents/**/*.md"
---

# Agent Authoring Rules

When writing or editing subagent markdown files:

## Structure
- YAML frontmatter for configuration
- Markdown body is the system prompt

## Required Frontmatter
- `name`: Unique identifier (lowercase, hyphens)
- `description`: When the agent should be delegated to — **must be a single-line quoted string** (VS Code parses `>-` multiline continuations as separate attributes)

## Optional Frontmatter
- `tools`: Allowlist of tools as a **YAML array** (inherits all if omitted)
- `model`: `sonnet`, `opus`, `haiku`, or `inherit`
- `handoffs`: Copilot-only agent transitions as a **YAML array** (no-op on other platforms)

VS Code supported attributes: `agents`, `argument-hint`, `description`, `disable-model-invocation`, `handoffs`, `model`, `name`, `target`, `tools`, `user-invokable`. Use `tools` allowlist instead of `disallowedTools` for cross-platform compatibility.

## Tools Syntax

The `tools` field **must be a YAML array**, not a comma-separated string.

```yaml
# Correct
tools:
  - Read
  - Grep
  - Glob

# Wrong — will error: "The 'tools' attribute must be an array"
tools: Read, Grep, Glob
```

## System Prompt Guidelines
- Be clear about agent's role and purpose
- Include step-by-step workflow when applicable
- Specify output format expectations
- Keep focused on one specific task

## Tool Restrictions
- Grant only necessary permissions via the `tools` allowlist
- For read-only agents, list only read tools: `[Read, Grep, Glob, Bash]`
- Reinforce restrictions in the system prompt body as defense-in-depth
