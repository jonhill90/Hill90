/**
 * Tests for model-router delegation token signing and endpoint.
 */

import * as crypto from 'crypto';

// Generate test Ed25519 keypair
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('ed25519');
const testPrivatePem = testPrivateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

// Set env before importing module
process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY = testPrivatePem;
process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = 'test-service-token-abc123';

import { signDelegationToken } from '../services/model-router-delegation';

function decodeJwt(token: string): { header: any; payload: any } {
  const [headerB64, payloadB64] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(headerB64, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString()),
  };
}

function verifyEd25519Jwt(token: string, publicKey: crypto.KeyObject): boolean {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, 'base64url');
  return crypto.verify(null, Buffer.from(signingInput), publicKey, signature);
}

describe('signDelegationToken', () => {
  const baseRequest = {
    sub: 'orchestrator-agent',
    delegation_id: '550e8400-e29b-41d4-a716-446655440000',
    parent_jti: 'parent-jti-abc',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  it('signs JWT with delegation claims', () => {
    const result = signDelegationToken(baseRequest);
    const { payload } = decodeJwt(result.token);

    expect(payload.sub).toBe('orchestrator-agent');
    expect(payload.delegation_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(payload.parent_jti).toBe('parent-jti-abc');
    expect(payload.iss).toBe('hill90-api');
    expect(payload.aud).toBe('hill90-model-router');
  });

  it('sets exp from request', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 7200;
    const result = signDelegationToken({ ...baseRequest, expires_at: expiresAt });
    const { payload } = decodeJwt(result.token);

    expect(payload.exp).toBe(expiresAt);
  });

  it('generates unique JTI per call', () => {
    const result1 = signDelegationToken(baseRequest);
    const result2 = signDelegationToken(baseRequest);

    expect(result1.jti).not.toBe(result2.jti);
    expect(result1.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('signature verifies with the public key', () => {
    const result = signDelegationToken(baseRequest);
    const valid = verifyEd25519Jwt(result.token, testPublicKey);
    expect(valid).toBe(true);
  });

  it('returns jti matching JWT payload', () => {
    const result = signDelegationToken(baseRequest);
    const { payload } = decodeJwt(result.token);
    expect(result.jti).toBe(payload.jti);
  });
});

describe('POST /internal/delegation-token', () => {
  // Use supertest for HTTP-level endpoint tests
  let request: any;

  beforeAll(async () => {
    const supertest = await import('supertest');
    // Re-import app (env vars already set above)
    const { createApp } = await import('../app');
    const app = createApp({ issuer: 'https://test-issuer' });
    request = supertest.default(app);
  });

  const validBody = {
    sub: 'orchestrator-agent',
    delegation_id: '550e8400-e29b-41d4-a716-446655440000',
    parent_jti: 'parent-jti-abc',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  it('signs and returns token with valid service token', async () => {
    const res = await request
      .post('/internal/delegation-token')
      .set('Authorization', 'Bearer test-service-token-abc123')
      .send(validBody)
      .expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.jti).toBeTruthy();

    const { payload } = decodeJwt(res.body.token);
    expect(payload.delegation_id).toBe(validBody.delegation_id);
    expect(payload.parent_jti).toBe(validBody.parent_jti);
    expect(payload.sub).toBe(validBody.sub);
  });

  it('rejects missing Authorization header', async () => {
    await request
      .post('/internal/delegation-token')
      .send(validBody)
      .expect(403);
  });

  it('rejects invalid service token', async () => {
    await request
      .post('/internal/delegation-token')
      .set('Authorization', 'Bearer wrong-token')
      .send(validBody)
      .expect(403);
  });

  it('rejects missing required fields', async () => {
    await request
      .post('/internal/delegation-token')
      .set('Authorization', 'Bearer test-service-token-abc123')
      .send({ sub: 'agent' })
      .expect(400);
  });
});
