/**
 * Platform models tests (M1-M5).
 *
 * Verifies that admin users can create and manage platform-level user_models
 * (created_by = NULL), non-admin users are blocked from the platform flag,
 * platform models are visible to all users in GET, and non-admin users
 * cannot modify or delete platform models.
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

describe('Platform Models (M1-M5)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // M1: Admin can create a platform model (created_by = NULL)
  it('M1: POST /user-models with admin token and platform: true creates model with created_by = NULL', async () => {
    // Connection ownership check: platform connection (created_by IS NULL) owned by admin
    // The implementation should accept connections owned by admin OR platform connections
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-conn-1' }] });
    // Platform model name collision check
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT returning the new platform model
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'platform-model-1', name: 'gpt-4o-platform', connection_id: 'platform-conn-1',
        litellm_model: 'openai/gpt-4o', description: 'Platform GPT-4o',
        is_active: true, model_type: 'single', detected_type: 'chat',
        capabilities: ['chat', 'function_calling'], routing_config: null,
        icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'gpt-4o-platform',
        connection_id: 'platform-conn-1',
        litellm_model: 'openai/gpt-4o',
        description: 'Platform GPT-4o',
        platform: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('gpt-4o-platform');

    // Verify the INSERT passes NULL for created_by
    const insertCall = mockQuery.mock.calls[2]; // 3rd call is the INSERT
    expect(insertCall[0]).toContain('INSERT INTO user_models');
    const params = insertCall[1];
    // The last param (created_by) should be null for platform models
    const createdByParam = params[params.length - 1];
    expect(createdByParam).toBeNull();
  });

  // M2: Non-admin cannot create platform models
  it('M2: POST /user-models with user token and platform: true returns 403', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'unauthorized-platform-model',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
        platform: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('admin');
  });

  // M3: GET /user-models as user includes platform models alongside own models
  it('M3: GET /user-models as user returns own models plus platform models', async () => {
    // The implementation should change query to include:
    // WHERE created_by = $1 OR created_by IS NULL
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-model-1', name: 'my-gpt4', connection_id: 'conn-1',
          litellm_model: 'openai/gpt-4o', is_active: true,
          created_by: 'regular-user',
        },
        {
          id: 'platform-model-1', name: 'gpt-4o-platform', connection_id: 'platform-conn-1',
          litellm_model: 'openai/gpt-4o', is_active: true,
          created_by: null,
        },
      ],
    });

    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    // Verify the query includes platform models (created_by IS NULL)
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by IS NULL');
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);

    // Verify both user-owned and platform models are returned
    const names = res.body.map((m: any) => m.name);
    expect(names).toContain('my-gpt4');
    expect(names).toContain('gpt-4o-platform');
  });

  // M4: Non-admin cannot update a platform model
  it('M4: PUT /user-models/:id as user for a platform model returns 403 or 404', async () => {
    // Ownership check: WHERE id = $1 AND created_by = $2
    // Platform model has created_by = NULL, won't match user's sub
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/user-models/platform-model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'hijacked-name' });

    // Should be 404 (not found for this user) since ownership check fails
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  // M5: Non-admin cannot delete a platform model
  it('M5: DELETE /user-models/:id as user for a platform model returns 404', async () => {
    // DELETE WHERE id = $1 AND created_by = $2
    // Platform model has created_by = NULL, won't match user's sub
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/user-models/platform-model-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  // M5b: Admin can delete a platform model
  it('M5b: DELETE /user-models/:id as admin for a platform model succeeds', async () => {
    // Admin DELETE should match platform models (created_by IS NULL)
    // DELETE returns the row
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'platform-model-1', name: 'gpt-4o-platform' }],
    });
    // Stale policy cleanup (best-effort)
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/user-models/platform-model-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    // Verify the DELETE query does not scope by created_by = admin-user
    // for platform models, or uses admin-aware query
    const deleteCall = mockQuery.mock.calls[0];
    expect(deleteCall[0]).toContain('DELETE FROM user_models');
  });

  // M5c: Admin can update a platform model
  it('M5c: PUT /user-models/:id as admin for a platform model succeeds', async () => {
    // Ownership check passes for admin (either admin sees all, or special platform check)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'platform-model-1', model_type: 'single' }],
    });
    // No name collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // UPDATE returns the updated row
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'platform-model-1', name: 'gpt-4o-platform-updated',
        connection_id: 'platform-conn-1', litellm_model: 'openai/gpt-4o',
        description: 'Updated', is_active: true, model_type: 'single',
        detected_type: 'chat', capabilities: ['chat'], routing_config: null,
        icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-03-29',
      }],
    });

    const res = await request(app)
      .put('/user-models/platform-model-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'gpt-4o-platform-updated' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('gpt-4o-platform-updated');
  });

  // M3b: Platform models should include an is_platform indicator in GET response
  it('M3b: GET /user-models marks platform models with is_platform: true in response', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'platform-model-1', name: 'gpt-4o-platform', created_by: null, is_active: true },
        { id: 'user-model-1', name: 'my-model', created_by: 'regular-user', is_active: true },
      ],
    });

    const res = await request(app)
      .get('/user-models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    // Platform model should have is_platform: true (or created_by: null)
    const platformModel = res.body.find((m: any) => m.name === 'gpt-4o-platform');
    expect(platformModel).toBeDefined();
    // The response should indicate this is a platform model.
    // Implementation may use is_platform flag or expose created_by = null.
    expect(platformModel.created_by === null || platformModel.is_platform === true).toBe(true);
  });
});
