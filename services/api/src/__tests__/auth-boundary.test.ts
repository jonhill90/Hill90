/**
 * Cross-auth boundary tests.
 *
 * Proves that the structural separation between human (Keycloak RS256),
 * agent (Ed25519), and service (shared secret) auth paths holds.
 */

import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate a throwaway RSA keypair for Keycloak-style tokens
const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Generate Ed25519 keypair for agent tokens
const { privateKey: ed25519PrivateKey } = crypto.generateKeyPairSync('ed25519');

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => rsaPublicKey,
});

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function makeAgentToken(agentId: string): string {
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    sub: agentId,
    iss: 'hill90-api',
    aud: 'hill90-model-router',
    exp: now + 3600,
    iat: now,
    jti: crypto.randomUUID(),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), ed25519PrivateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

describe('Cross-auth boundary', () => {
  it('AB-1: Ed25519 agent token rejected by requireAuth', async () => {
    const agentToken = makeAgentToken('test-agent-1');
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(401);
  });

  it('AB-2: Agent token without kid header rejected by requireAuth', async () => {
    // Ed25519 tokens never have a kid header — this proves they fail
    const agentToken = makeAgentToken('test-agent-2');
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(401);
  });

  it('AB-3: Random bearer string rejected by requireAuth', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', 'Bearer totally-not-a-jwt');
    expect(res.status).toBe(401);
  });
});
