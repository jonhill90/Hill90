# Skills Catalog

This directory contains reusable skills for AI coding assistants (Claude, GitHub Copilot, Codex).

## What are Skills?

Skills are modular, task-specific workflows that can be invoked during AI-assisted coding sessions. Each skill provides focused capabilities with clear instructions and dynamic context injection.

## Available Skills

### Documentation & Research

| Skill | Description | Usage |
|-------|-------------|-------|
| **context7** | Fetch up-to-date library documentation | Use when asking about libraries, frameworks, or needing current API references/code examples |
| **ms-learn** | Query official Microsoft documentation | For Azure, .NET, Microsoft 365 concepts, tutorials, and best practices |
| **primer** | Orient in any codebase | Run at session start or when switching codebases for quick overview |

### Development Tools

| Skill | Description | Usage |
|-------|-------------|-------|
| **create-skill** | Guide for creating new skills | Use when designing or building new skills with scripts and references |
| **lint-agents** | Validate agent definition files | Check .md agent files for correct YAML frontmatter syntax |
| **validate-skill** | Validate SKILL.md files | Ensure skills follow Agent Skills specification |

### GitHub & Linear

| Skill | Description | Usage |
|-------|-------------|-------|
| **gh-cli** | Manage GitHub via CLI | PRs, issues, workflows, actions, releases, repository management |
| **linear** | Manage Linear issues and projects | Issue tracking, sprint workflows, branch creation, PR generation |

### Infrastructure

| Skill | Description | Usage |
|-------|-------------|-------|
| **hostinger** | Manage Hostinger VPS and DNS | VPS operations, DNS records, snapshots, infrastructure on hill90.com |

### Personal Knowledge

| Skill | Description | Usage |
|-------|-------------|-------|
| **obsidian** | Manage Obsidian notes | Read, write, search notes in vaults using obsidian-cli |
| **youtube-transcript** | Fetch YouTube transcripts | Get video transcripts and metadata from YouTube links |

## How to Use

Skills are automatically available in AI coding sessions. Invoke them by calling the skill tool with the skill name:

```
skill: primer
skill: validate-skill path/to/skill
```

Some skills accept arguments (shown in their `argument-hint` field).

## Creating New Skills

See the **create-skill** skill for guidance on creating new skills.

Key requirements:
- File must be named `SKILL.md`
- YAML frontmatter with `name` and `description`
- Clear, actionable instructions
- Keep under 500 lines (use reference files for more)

## Validation

Run the `validate-skill` skill to check if a SKILL.md file follows the specification:

```
skill: validate-skill .github/skills/my-skill
```

Or use the `lint-agents` skill to validate all agent files.

## Directory Structure

Each skill has its own directory:

```
.github/skills/
├── primer/
│   └── SKILL.md
├── validate-skill/
│   └── SKILL.md
├── linear/
│   └── SKILL.md
└── ...
```

Skills may include additional files:
- `scripts/` - Executable helper scripts
- `references/` - Supporting documentation
- Other assets as needed

## Testing

Skills are tested through:
1. Manual invocation during development
2. Validation via `validate-skill`
3. CI checks in `.github/workflows/ci.yml`

## Related Documentation

- **Skill Authoring Guide**: `.github/instructions/skill-authoring.instructions.md`
- **Agent Authoring Guide**: `.github/instructions/agent-authoring.instructions.md`
- **Harness Reference**: `.github/docs/harness-reference.md`
