#!/usr/bin/env bats

# Test instruction files have valid frontmatter and proper structure

setup() {
    REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    cd "$REPO_ROOT"
}

@test "All instruction files exist" {
    [ -f ".github/instructions/agent-authoring.instructions.md" ]
    [ -f ".github/instructions/documentation.instructions.md" ]
    [ -f ".github/instructions/infrastructure.instructions.md" ]
    [ -f ".github/instructions/reference-freshness.instructions.md" ]
    [ -f ".github/instructions/skill-authoring.instructions.md" ]
    [ -f ".github/instructions/testing.instructions.md" ]
    [ -f ".github/instructions/workflows.instructions.md" ]
}

@test "Instruction files have YAML frontmatter" {
    for file in .github/instructions/*.instructions.md; do
        # Check file starts with ---
        head -n 1 "$file" | grep -q "^---$" || {
            echo "Missing frontmatter in $file"
            return 1
        }
    done
}

@test "Instruction files have description field" {
    for file in .github/instructions/*.instructions.md; do
        grep -q "^description:" "$file" || {
            echo "Missing description in $file"
            return 1
        }
    done
}

@test "Instruction files have applyTo field" {
    for file in .github/instructions/*.instructions.md; do
        grep -q "^applyTo:" "$file" || {
            echo "Missing applyTo in $file"
            return 1
        }
    done
}

@test "Agent authoring instructions apply to agent files" {
    grep -q "applyTo:.*agents" ".github/instructions/agent-authoring.instructions.md"
}

@test "Skill authoring instructions apply to skill files" {
    grep -q "applyTo:.*skills" ".github/instructions/skill-authoring.instructions.md"
}

@test "Infrastructure instructions apply to infra files" {
    grep -q "applyTo:" ".github/instructions/infrastructure.instructions.md"
    grep -q "infra" ".github/instructions/infrastructure.instructions.md"
    grep -q "deploy" ".github/instructions/infrastructure.instructions.md"
    grep -q "scripts" ".github/instructions/infrastructure.instructions.md"
}

@test "Testing instructions apply to test files" {
    grep -q "applyTo:" ".github/instructions/testing.instructions.md"
    grep -q "tests" ".github/instructions/testing.instructions.md"
}

@test "Workflows instructions apply to workflow files" {
    grep -q "applyTo:.*workflows" ".github/instructions/workflows.instructions.md"
}

@test "All instruction files end with .instructions.md" {
    for file in .github/instructions/*.md; do
        basename "$file" | grep -q "\.instructions\.md$" || {
            echo "File $file doesn't follow .instructions.md naming convention"
            return 1
        }
    done
}
