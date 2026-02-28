/**
 * Model-router token revocation — called on agent stop.
 *
 * Sends a revocation request to the AI service internal endpoint
 * using the internal service token for authentication.
 * Mirrors the AKM revoke pattern targeting the AI service.
 */

const MODEL_ROUTER_URL = process.env.MODEL_ROUTER_URL || 'http://ai:8000';
const MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;

/**
 * Revoke an agent's model-router JWT by its jti claim.
 * Idempotent — safe to call multiple times.
 *
 * @param expiresAt - The actual JWT exp claim value (Unix timestamp).
 *   Falls back to now+3600 if not provided for backward compatibility.
 */
export async function revokeAgentModelRouterToken(
  agentId: string,
  jti: string,
  expiresAt?: number,
): Promise<void> {
  if (!MODEL_ROUTER_INTERNAL_SERVICE_TOKEN) {
    console.warn('[model-router-revoke] MODEL_ROUTER_INTERNAL_SERVICE_TOKEN not set, skipping revocation');
    return;
  }

  const effectiveExpiresAt = expiresAt ?? Math.floor(Date.now() / 1000) + 3600;

  const resp = await fetch(`${MODEL_ROUTER_URL}/internal/revoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MODEL_ROUTER_INTERNAL_SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jti, agent_id: agentId, expires_at: effectiveExpiresAt }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Model-router revocation failed (${resp.status}): ${body}`);
  }
}
