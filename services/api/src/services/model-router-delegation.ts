/**
 * Model-router delegation token signing.
 *
 * Signs child JWTs for delegated subagent narrowing. Called by the AI service
 * via internal service-to-service endpoint. The child JWT carries delegation_id
 * and parent_jti claims that distinguish it from parent tokens.
 */

import * as crypto from 'crypto';
import { Router, Request, Response } from 'express';

const MODEL_ROUTER_SIGNING_PRIVATE_KEY = process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY;
const MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;

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

export interface DelegationTokenRequest {
  sub: string;
  delegation_id: string;
  parent_jti: string;
  expires_at: number;
}

export interface DelegationTokenResult {
  token: string;
  jti: string;
}

/**
 * Sign a child JWT for a delegated subagent.
 *
 * Same iss/aud as parent tokens — the AI service verifies both with the
 * same public key. The delegation_id and parent_jti claims distinguish
 * child tokens from parent tokens.
 */
export function signDelegationToken(req: DelegationTokenRequest): DelegationTokenResult {
  const privateKey = getPrivateKey();
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: req.sub,
    iss: 'hill90-api',
    aud: 'hill90-model-router',
    delegation_id: req.delegation_id,
    parent_jti: req.parent_jti,
    exp: req.expires_at,
    iat: now,
    jti,
  }));

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const token = `${signingInput}.${signature.toString('base64url')}`;

  return { token, jti };
}

/**
 * Express handler for POST /internal/delegation-token.
 *
 * Authenticated via MODEL_ROUTER_INTERNAL_SERVICE_TOKEN (HMAC comparison).
 * Not reachable externally — only on hill90_internal Docker network.
 */
export function delegationTokenHandler(req: Request, res: Response): void {
  // Validate service token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(403).json({ error: 'Missing service token' });
    return;
  }

  const token = authHeader.slice(7);
  if (!MODEL_ROUTER_INTERNAL_SERVICE_TOKEN) {
    res.status(503).json({ error: 'Service token not configured' });
    return;
  }

  const expected = Buffer.from(MODEL_ROUTER_INTERNAL_SERVICE_TOKEN);
  const received = Buffer.from(token);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(403).json({ error: 'Invalid service token' });
    return;
  }

  // Validate request body
  const { sub, delegation_id, parent_jti, expires_at } = req.body;
  if (!sub || !delegation_id || !parent_jti || !expires_at) {
    res.status(400).json({ error: 'Missing required fields: sub, delegation_id, parent_jti, expires_at' });
    return;
  }

  try {
    const result = signDelegationToken({ sub, delegation_id, parent_jti, expires_at });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `Token signing failed: ${err.message}` });
  }
}
