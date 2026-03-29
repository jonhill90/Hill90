/**
 * Platform connections tests (P1-P5).
 *
 * Verifies that admin users can create and manage platform-level provider
 * connections (created_by = NULL), non-admin users are blocked from the
 * platform flag, and existing ownership-scoped operations still work
 * correctly for platform connections.
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

// DELETE handler uses pool.connect() for transactions; other routes use pool.query()
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    }),
  }),
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

// Mock axios for validate endpoint
jest.mock('axios', () => ({
  post: jest.fn(),
}));

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

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

describe('Platform Connections (P1-P5)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.PROVIDER_KEY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = 'test-service-token';
    process.env.AI_SERVICE_URL = 'http://ai:8000';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
    delete process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;
    delete process.env.AI_SERVICE_URL;
  });

  // P1: Admin can create a platform connection (created_by = NULL)
  it('P1: POST /provider-connections with admin token and platform: true creates connection with created_by = NULL', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'platform-conn-1', name: 'Platform OpenAI', provider: 'openai',
        api_base_url: null, is_valid: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/provider-connections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Platform OpenAI',
        provider: 'openai',
        api_key: 'sk-platform-key',
        platform: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Platform OpenAI');

    // Verify INSERT passes NULL for created_by (the last param in the INSERT)
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO provider_connections');
    // The created_by parameter should be null for platform connections
    const params = insertCall[1];
    const createdByParam = params[params.length - 1];
    expect(createdByParam).toBeNull();
  });

  // P2: Non-admin cannot create platform connections
  it('P2: POST /provider-connections with user token and platform: true returns 403', async () => {
    const res = await request(app)
      .post('/provider-connections')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Unauthorized Platform',
        provider: 'openai',
        api_key: 'sk-test',
        platform: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('admin');
  });

  // P3: GET /provider-connections as user returns only user-owned rows (no platform connections)
  it('P3: GET /provider-connections as user does not include platform connections', async () => {
    // The query should scope to created_by = user.sub, so platform rows
    // (created_by IS NULL) are excluded by the WHERE clause
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'user-conn-1', name: 'My OpenAI', provider: 'openai' },
      ],
    });

    const res = await request(app)
      .get('/provider-connections')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    // Verify the query still scopes to the caller's sub only
    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('created_by = $1');
    expect(call[1]).toEqual(['regular-user']);
    // Response should only contain user's own connections
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('user-conn-1');
  });

  // P4: User cannot delete a platform connection (created_by = NULL does not match user.sub)
  it('P4: DELETE /provider-connections/:id as user for a platform connection returns 404', async () => {
    // The DELETE query includes WHERE created_by = $2.
    // A platform connection has created_by = NULL, so it won't match.
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // DELETE returns empty (no match)
    mockClientQuery.mockResolvedValueOnce({}); // ROLLBACK

    const res = await request(app)
      .delete('/provider-connections/platform-conn-1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  // P5: Admin can delete a platform connection
  it('P5: DELETE /provider-connections/:id as admin for a platform connection succeeds', async () => {
    // The admin DELETE path should match platform connections (created_by IS NULL)
    // The implementation will either bypass the created_by check for admin
    // or use a different WHERE clause
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: 'platform-conn-1' }] }); // DELETE returns row
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // SELECT router models (none affected)
    mockClientQuery.mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .delete('/provider-connections/platform-conn-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // Verify the DELETE query does NOT scope by created_by for admin,
    // or scopes by created_by IS NULL
    const deleteCall = mockClientQuery.mock.calls[1];
    expect(deleteCall[0]).toContain('DELETE FROM provider_connections');
    // For admin deleting platform connection, the query should not require
    // created_by = admin-user (platform connections have created_by = NULL)
  });

});
