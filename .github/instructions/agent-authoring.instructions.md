---
description: 'Guidelines for writing and editing agent definition files'
applyTo: '.github/agents/**/*.md'
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
- `permissionMode`: Permission handling
- `skills`: Skills to preload into context
- `hooks`: Lifecycle hooks (Claude Code only)
- `handoffs`: Copilot-only agent transitions as a **YAML array** (Claude Code and Codex silently ignore this key)

### VS Code Compatibility

VS Code agent files support only these attributes: `agents`, `argument-hint`, `description`, `disable-model-invocation`, `handoffs`, `model`, `name`, `target`, `tools`, `user-invokable`.

**Not supported by VS Code** (Claude Code / Codex only):
- `disallowedTools` — use `tools` allowlist instead to restrict available tools
- `permissionMode`
- `skills`
- `hooks`

### Handoffs Syntax

The `handoffs` field enables one-click agent transitions in Copilot. It is a no-op on other platforms.

```yaml
handoffs:
  - label: "Descriptive button text"
    agent: target-agent-name
    prompt: "Context passed to the target agent"
    send: false
```

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
