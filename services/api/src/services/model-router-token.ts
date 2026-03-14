/**
 * Model-router token generation.
 *
 * Generates Ed25519 JWTs for agent containers to authenticate with the AI service
 * (model-router). Mirrors the AKM token pattern but with audience 'hill90-model-router'.
 * JWT carries identity only — no model scopes in claims.
 */

import * as crypto from 'crypto';

const MODEL_ROUTER_URL = process.env.MODEL_ROUTER_URL || 'http://ai:8000';
const MODEL_ROUTER_SIGNING_PRIVATE_KEY = process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY;

let cachedPrivateKey: crypto.KeyObject | null = null;

function getPrivateKey(): crypto.KeyObject {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!MODEL_ROUTER_SIGNING_PRIVATE_KEY) {
    throw new Error('MODEL_ROUTER_SIGNING_PRIVATE_KEY not configured');
  }
  cachedPrivateKey = crypto.createPrivateKey(MODEL_ROUTER_SIGNING_PRIVATE_KEY);
  return cachedPrivateKey;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

export interface ModelRouterTokenResult {
  token: string;
  jti: string;
  expiresAt: number;
}

/**
 * Generate an Ed25519 JWT for an agent to authenticate with the model-router.
 * JWT carries identity only: sub (agent_id), iss, aud, exp, iat, jti.
 * No model scopes — authorization is resolved server-side from DB policy.
 */
export async function generateAgentModelRouterToken(
  agentId: string,
  owner: string,
): Promise<ModelRouterTokenResult> {
  const privateKey = getPrivateKey();
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 3600; // 1 hour

  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: agentId,
    iss: 'hill90-api',
    aud: 'hill90-model-router',
    exp: expiresAt,
    iat: now,
    jti,
    owner,
  }));

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const token = `${signingInput}.${signature.toString('base64url')}`;

  return { token, jti, expiresAt };
}

/**
 * Get the model-router env vars to inject into an agent container.
 */
export function getModelRouterEnvVars(tokenResult: ModelRouterTokenResult): string[] {
  return [
    `MODEL_ROUTER_TOKEN=${tokenResult.token}`,
    `MODEL_ROUTER_URL=${MODEL_ROUTER_URL}`,
  ];
}

/**
 * Check if model-router integration is configured.
 */
export function isModelRouterConfigured(): boolean {
  return !!MODEL_ROUTER_SIGNING_PRIVATE_KEY;
}
