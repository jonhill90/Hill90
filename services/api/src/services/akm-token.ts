/**
 * AKM (Agent Knowledge Manager) token generation.
 *
 * Generates Ed25519 JWTs for agent containers to authenticate with the AKM service.
 * Uses Node.js native crypto for Ed25519 signing (no external JWT library needed
 * since jsonwebtoken doesn't support EdDSA).
 */

import * as crypto from 'crypto';

const AKM_SERVICE_URL = process.env.AKM_SERVICE_URL || 'http://knowledge:8002';
const AKM_SIGNING_PRIVATE_KEY = process.env.AKM_SIGNING_PRIVATE_KEY;

let cachedPrivateKey: crypto.KeyObject | null = null;

function getPrivateKey(): crypto.KeyObject {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!AKM_SIGNING_PRIVATE_KEY) {
    throw new Error('AKM_SIGNING_PRIVATE_KEY not configured');
  }
  cachedPrivateKey = crypto.createPrivateKey(AKM_SIGNING_PRIVATE_KEY);
  return cachedPrivateKey;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

export interface AkmTokenResult {
  token: string;
  jti: string;
  refreshSecret: string;
  expiresAt: number;
}

/**
 * Generate an Ed25519 JWT and refresh secret for an agent.
 */
export async function generateAgentAkmToken(
  agentId: string,
  scopes: string[] = ['akm:read', 'akm:write'],
  owner?: string,
): Promise<AkmTokenResult> {
  const privateKey = getPrivateKey();
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 3600; // 1 hour

  // Build JWT manually with Ed25519 signing
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: agentId,
    iss: 'hill90-api',
    aud: 'hill90-akm',
    exp: expiresAt,
    iat: now,
    jti,
    scopes,
    ...(owner ? { owner } : {}),
  }));

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const token = `${signingInput}.${signature.toString('base64url')}`;

  const refreshSecret = crypto.randomUUID();

  return { token, jti, refreshSecret, expiresAt };
}

/**
 * Get the AKM env vars to inject into an agent container.
 */
export function getAkmEnvVars(tokenResult: AkmTokenResult): string[] {
  return [
    `AKM_TOKEN=${tokenResult.token}`,
    `AKM_SERVICE_URL=${AKM_SERVICE_URL}`,
    `AKM_REFRESH_URL=${AKM_SERVICE_URL}/internal/agents/refresh-token`,
    `AKM_REFRESH_SECRET=${tokenResult.refreshSecret}`,
    `AKM_REFRESH_SECRET_FILE=/data/.akm_refresh_secret`,
  ];
}

/**
 * Check if AKM integration is configured.
 */
export function isAkmConfigured(): boolean {
  return !!AKM_SIGNING_PRIVATE_KEY;
}
