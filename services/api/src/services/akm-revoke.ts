/**
 * AKM token revocation — called on agent stop.
 *
 * Sends a revocation request to the AKM internal endpoint
 * using the internal service token for authentication.
 */

const AKM_SERVICE_URL = process.env.AKM_SERVICE_URL || 'http://knowledge:8002';
const AKM_INTERNAL_SERVICE_TOKEN = process.env.AKM_INTERNAL_SERVICE_TOKEN;

/**
 * Revoke an agent's AKM JWT by its jti claim.
 * Idempotent — safe to call multiple times.
 *
 * @param expiresAt - The actual JWT exp claim value (Unix timestamp).
 *   Falls back to now+3600 if not provided for backward compatibility.
 */
export async function revokeAgentAkmToken(agentId: string, jti: string, expiresAt?: number): Promise<void> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    console.warn('[akm-revoke] AKM_INTERNAL_SERVICE_TOKEN not set, skipping revocation');
    return;
  }

  // Use actual token expiry if available, otherwise fall back to 1h from now
  const effectiveExpiresAt = expiresAt ?? Math.floor(Date.now() / 1000) + 3600;

  const resp = await fetch(`${AKM_SERVICE_URL}/internal/revoke`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jti, agent_id: agentId, expires_at: effectiveExpiresAt }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`AKM revocation failed (${resp.status}): ${body}`);
  }
}
