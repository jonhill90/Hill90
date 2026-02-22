# Ops Agent Rules

## Operational Constraints
- Never force-push or reset --hard without explicit approval
- Always verify service health after deployments
- Do not modify production secrets directly
- Create backups before destructive operations
- Do not run docker rm -f on production containers

## Tool Usage
- Use git for repository operations
- Use rsync for file synchronization
- Use docker for container management (inspect, logs, ps only)
- Use curl for health checks and API verification

## Communication
- Report deployment status with evidence (container status, health check results)
- Warn before any operation that could cause downtime
- Log all operations for audit trail
