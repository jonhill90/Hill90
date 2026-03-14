/**
 * Tests for model-router token generation.
 * Mirrors the AKM token pattern but with audience 'hill90-model-router'.
 */

import * as crypto from 'crypto';

// Generate test Ed25519 keypair
const { publicKey: testPublicKey, privateKey: testPrivateKey } = crypto.generateKeyPairSync('ed25519');
const testPrivatePem = testPrivateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const testPublicPem = testPublicKey.export({ type: 'spki', format: 'pem' }) as string;

// Set env before importing module
process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY = testPrivatePem;

import {
  generateAgentModelRouterToken,
  getModelRouterEnvVars,
  isModelRouterConfigured,
} from '../services/model-router-token';

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

describe('generateAgentModelRouterToken', () => {
  it('generates a valid Ed25519 JWT', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    expect(result.token).toBeTruthy();
    expect(result.jti).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('uses hill90-model-router audience (not hill90-akm)', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    const { payload } = decodeJwt(result.token);
    expect(payload.aud).toBe('hill90-model-router');
    expect(payload.iss).toBe('hill90-api');
    expect(payload.sub).toBe('test-agent-1');
  });

  it('JWT carries identity only — no model scopes in claims', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    const { payload } = decodeJwt(result.token);
    expect(payload.scopes).toBeUndefined();
    expect(payload.models).toBeUndefined();
    expect(payload.allowed_models).toBeUndefined();
  });

  it('includes jti for revocation tracking', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    const { payload } = decodeJwt(result.token);
    expect(payload.jti).toBe(result.jti);
    // JTI should be a UUID
    expect(payload.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('signature verifies with the public key', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    const valid = verifyEd25519Jwt(result.token, testPublicKey);
    expect(valid).toBe(true);
  });

  it('has 1-hour expiry', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    const { payload } = decodeJwt(result.token);
    // exp should be ~1h from now (allow 2s tolerance)
    expect(payload.exp).toBeGreaterThanOrEqual(before + 3600 - 2);
    expect(payload.exp).toBeLessThanOrEqual(before + 3600 + 2);
  });
});

describe('getModelRouterEnvVars', () => {
  it('returns MODEL_ROUTER_TOKEN and MODEL_ROUTER_URL', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'test-owner');
    const envVars = getModelRouterEnvVars(result);
    expect(envVars).toContainEqual(expect.stringMatching(/^MODEL_ROUTER_TOKEN=/));
    expect(envVars).toContainEqual(expect.stringMatching(/^MODEL_ROUTER_URL=/));
  });
});

describe('isModelRouterConfigured', () => {
  it('returns true when private key is set', () => {
    expect(isModelRouterConfigured()).toBe(true);
  });
});

describe('model-router token owner claim', () => {
  it('MRT-1: includes owner claim in JWT payload', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'owner-uuid-123');
    const { payload } = decodeJwt(result.token);
    expect(payload.owner).toBe('owner-uuid-123');
  });

  it('MRT-2: owner claim survives Ed25519 round-trip', async () => {
    const result = await generateAgentModelRouterToken('test-agent-1', 'owner-uuid-456');
    const valid = verifyEd25519Jwt(result.token, testPublicKey);
    expect(valid).toBe(true);
    const { payload } = decodeJwt(result.token);
    expect(payload.owner).toBe('owner-uuid-456');
  });
});
