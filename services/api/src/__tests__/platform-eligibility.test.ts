/**
 * Platform eligibility tests (E12-E15).
 *
 * Verifies that platform models (created_by IS NULL in user_models) are
 * included in eligible-models results, accepted by validateAllowedModels
 * for model policies, and that platform model name collisions are still
 * blocked on user model creation.
 */

import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, realm_roles: roles },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const adminToken = makeToken('admin-user', ['admin', 'user']);
const userToken = makeToken('regular-user', ['user']);

describe('Platform Eligibility (E12-E15)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // E12: GET /eligible-models includes platform models (created_by IS NULL)
  it('E12: GET /eligible-models includes platform models alongside user models', async () => {
    // The implementation should change the query to:
    // WHERE (created_by = $1 OR created_by IS NULL) AND is_active = true
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          name: 'my-gpt4', description: 'My GPT-4', connection_id: 'conn-1',
          is_active: true, model_type: 'single', detected_type: 'chat',
        },
        {
          name: 'gpt-4o-platform', description: 'Platform GPT-4o', connection_id: 'platform-conn-1',
          is_active: true, model_type: 'single', detected_type: 'chat',
        },
      ],
    });

    const res = await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(2);

    // Verify the query now includes platform models
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by IS NULL');
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);

    // Verify both user-owned and platform models appear
    const names = res.body.models.map((m: any) => m.name);
    expect(names).toContain('my-gpt4');
    expect(names).toContain('gpt-4o-platform');
  });

  // E12b: Platform models are excluded when inactive
  it('E12b: GET /eligible-models excludes inactive platform models by default', async () => {
    // Only active models should be returned
    mockQuery.mockResolvedValueOnce({
      rows: [
        { name: 'active-platform', is_active: true, model_type: 'single', detected_type: 'chat' },
      ],
    });

    const res = await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);

    // Verify is_active = true filter is still applied
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('is_active = true');
  });

  // E12c: include_inactive=true shows inactive platform models too
  it('E12c: GET /eligible-models?include_inactive=true includes inactive platform models', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { name: 'active-platform', is_active: true, model_type: 'single' },
        { name: 'inactive-platform', is_active: false, model_type: 'single' },
      ],
    });

    const res = await request(app)
      .get('/eligible-models?include_inactive=true')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    // Verify is_active filter is removed
    const call = mockQuery.mock.calls[0];
    expect(call[0]).not.toContain('is_active = true');
    // But platform models should still be included
    expect(call[0]).toContain('created_by IS NULL');
  });

  // E13: validateAllowedModels accepts platform model names for user policies
  it('E13: POST /model-policies with platform model name in allowed_models succeeds for user', async () => {
    // validateAllowedModels should now check:
    // WHERE name = $1 AND (created_by = $2 OR created_by IS NULL) AND is_active = true
    // First model check: 'gpt-4o-platform' found as platform model
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-model-1' }] });
    // INSERT the policy
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', name: 'my-policy',
        allowed_models: ['gpt-4o-platform'],
        created_by: 'regular-user',
      }],
    });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-policy',
        allowed_models: ['gpt-4o-platform'],
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-policy');

    // Verify the validateAllowedModels query includes platform model check
    const validateCall = mockQuery.mock.calls[0];
    expect(validateCall[0]).toContain('user_models');
    // The query should now include OR created_by IS NULL
    expect(validateCall[0]).toContain('created_by IS NULL');
  });

  // E13b: validateAllowedModels accepts mix of user and platform model names
  it('E13b: POST /model-policies with mix of user and platform models succeeds', async () => {
    // First model: 'my-gpt4' — user's own model
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-model-1' }] });
    // Second model: 'gpt-4o-platform' — platform model
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-model-1' }] });
    // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p2', name: 'mixed-policy',
        allowed_models: ['my-gpt4', 'gpt-4o-platform'],
        created_by: 'regular-user',
      }],
    });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'mixed-policy',
        allowed_models: ['my-gpt4', 'gpt-4o-platform'],
      });

    expect(res.status).toBe(201);
    expect(res.body.allowed_models).toEqual(['my-gpt4', 'gpt-4o-platform']);
  });

  // E14: validateAllowedModels on PUT also accepts platform model names
  it('E14: PUT /model-policies/:id with platform model in allowed_models succeeds', async () => {
    // Ownership check passes
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'p1', allowed_models: ['my-gpt4'], created_by: 'regular-user' }],
    });
    // validateAllowedModels for 'gpt-4o-platform': found as platform model
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-model-1' }] });
    // UPDATE
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', name: 'updated-policy',
        allowed_models: ['gpt-4o-platform'],
        created_by: 'regular-user',
      }],
    });

    const res = await request(app)
      .put('/model-policies/p1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ allowed_models: ['gpt-4o-platform'] });

    expect(res.status).toBe(200);
    expect(res.body.allowed_models).toEqual(['gpt-4o-platform']);

    // Verify validateAllowedModels query includes created_by IS NULL
    const validateCall = mockQuery.mock.calls[1];
    expect(validateCall[0]).toContain('user_models');
    expect(validateCall[0]).toContain('created_by IS NULL');
  });

  // E15: Platform user_model name collision still blocked
  it('E15: POST /user-models with name matching active platform user_model returns 409', async () => {
    // Connection ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform model collision: a platform user_model with this name exists
    // The implementation checks user_models WHERE name = $1 AND created_by IS NULL AND is_active = true
    // (or model_catalog, depending on design — but the collision check should cover platform user_models)
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'gpt-4o-platform' }] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'gpt-4o-platform',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('conflicts with a platform model');
  });

  // E15b: User model name collision with model_catalog also still blocked
  it('E15b: POST /user-models with name matching model_catalog entry returns 409', async () => {
    // Connection ownership OK
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform model collision: model_catalog has this name
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'gpt-4o-mini' }] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'gpt-4o-mini',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o-mini',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('conflicts with a platform model');
  });

  // E13c: Non-existent model name still rejected by validateAllowedModels
  it('E13c: POST /model-policies with nonexistent model name returns 400', async () => {
    // validateAllowedModels: not found in user models or platform models
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/model-policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'bad-policy',
        allowed_models: ['nonexistent-model'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Model 'nonexistent-model' not found");
  });

  // E12d: Admin eligible-models also includes platform models
  it('E12d: GET /eligible-models as admin includes platform models', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { name: 'admin-model', is_active: true, model_type: 'single', detected_type: 'chat' },
        { name: 'gpt-4o-platform', is_active: true, model_type: 'single', detected_type: 'chat' },
      ],
    });

    const res = await request(app)
      .get('/eligible-models')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(2);

    // Verify query includes platform scope
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by IS NULL');
  });
});
