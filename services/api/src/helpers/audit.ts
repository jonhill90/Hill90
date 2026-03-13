/**
 * Structured audit log helper.
 * Emits JSON to stdout for Promtail → Loki collection.
 */
export function auditLog(action: string, agentId: string, userSub: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    type: 'audit',
    action,
    agent_id: agentId,
    user_sub: userSub,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
}
