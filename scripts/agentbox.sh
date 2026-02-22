#!/usr/bin/env bash
# AgentBox Management CLI
# Usage: agentbox.sh {list|generate|start|stop|status|logs} [agent-id]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose/prod/docker-compose.agentbox.yml"
AGENTS_DIR="$REPO_ROOT/platform/agentbox/agents"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
    cat <<EOF
AgentBox Management CLI

Usage: agentbox.sh <command> [agent-id]

Commands:
  list       List configured agents
  generate   Regenerate compose from agent configs
  start      Start agent container(s) (generates compose first)
  stop       Stop agent container(s)
  status     Show running agent containers
  logs       Show agent container logs
  help       Show this help message

Examples:
  agentbox.sh list                  # List all configured agents
  agentbox.sh start                 # Start all agents
  agentbox.sh start coder           # Start only the coder agent
  agentbox.sh logs coder            # Show coder agent logs
  agentbox.sh stop                  # Stop all agents
EOF
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_list() {
    echo "Configured agents:"
    echo ""
    printf "%-12s %-20s %s\n" "ID" "NAME" "TOOLS"
    printf "%-12s %-20s %s\n" "---" "----" "-----"

    for agent_dir in "$AGENTS_DIR"/*/; do
        [ -d "$agent_dir" ] || continue
        config="$agent_dir/agent.yml"
        [ -f "$config" ] || continue

        id=$(python3 -c "import yaml; d=yaml.safe_load(open('$config')); print(d['id'])")
        name=$(python3 -c "import yaml; d=yaml.safe_load(open('$config')); print(d['name'])")
        tools=$(python3 -c "
import yaml
d=yaml.safe_load(open('$config'))
t=d.get('tools',{})
enabled=[k for k,v in t.items() if v.get('enabled',False)]
print(', '.join(enabled))
")
        printf "%-12s %-20s %s\n" "$id" "$name" "$tools"
    done
    echo ""
}

cmd_generate() {
    echo "Generating compose from agent configs..."
    python3 "$SCRIPT_DIR/agentbox-compose-gen.py"
}

cmd_start() {
    local agent_id="${1:-}"

    cmd_generate

    if [ -n "$agent_id" ]; then
        echo "Starting agentbox-${agent_id}..."
        docker compose -p agentbox -f "$COMPOSE_FILE" up -d "agentbox-${agent_id}"
    else
        echo "Starting all agent containers..."
        docker compose -p agentbox -f "$COMPOSE_FILE" up -d
    fi
}

cmd_stop() {
    local agent_id="${1:-}"

    if [ -n "$agent_id" ]; then
        echo "Stopping agentbox-${agent_id}..."
        docker compose -p agentbox -f "$COMPOSE_FILE" stop "agentbox-${agent_id}"
    else
        echo "Stopping all agent containers..."
        docker compose -p agentbox -f "$COMPOSE_FILE" stop
    fi
}

cmd_status() {
    if [ -f "$COMPOSE_FILE" ]; then
        docker compose -p agentbox -f "$COMPOSE_FILE" ps
    else
        echo "No compose file found. Run 'agentbox.sh generate' first."
    fi
}

cmd_logs() {
    local agent_id="${1:-}"

    if [ -n "$agent_id" ]; then
        docker compose -p agentbox -f "$COMPOSE_FILE" logs -f "agentbox-${agent_id}"
    else
        docker compose -p agentbox -f "$COMPOSE_FILE" logs -f
    fi
}

# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

main() {
    if [ $# -lt 1 ]; then
        usage
        exit 1
    fi

    local cmd="$1"
    shift

    case "$cmd" in
        list)                cmd_list "$@" ;;
        generate)            cmd_generate "$@" ;;
        start)               cmd_start "$@" ;;
        stop)                cmd_stop "$@" ;;
        status)              cmd_status "$@" ;;
        logs)                cmd_logs "$@" ;;
        help|--help|-h)      usage ;;
        *)
            echo "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
