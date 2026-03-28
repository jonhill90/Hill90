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

// The DELETE handler uses pool.connect() → client.query() for transactions.
// Other routes use pool.query() directly.
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
jest.mock('../services/provider-key-crypto', () => ({
  encryptProviderKey: jest.fn(() => ({ encrypted: Buffer.from('enc'), nonce: Buffer.from('nonce') })),
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

const userToken = makeToken('regular-user', ['user']);

describe('Provider Connections — JSONB Cascade', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // F1: DELETE connection scrubs route from routing_config (JSONB)
  it('F1: DELETE scrubs route from routing_config', async () => {
    const deletedConnId = 'conn-deleted';
    // BEGIN
    mockClientQuery.mockResolvedValueOnce({});
    // DELETE returns success
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: deletedConnId }] });
    // Find router models with routes referencing deleted connection
    mockClientQuery.mockResolvedValueOnce({
      rows: [{
        id: 'router-1',
        routing_config: {
          strategy: 'fallback',
          default_route: 'keep',
          routes: [
            { key: 'remove', connection_id: deletedConnId, litellm_model: 'openai/gpt-4o', priority: 1 },
            { key: 'keep', connection_id: 'conn-keep', litellm_model: 'anthropic/claude-sonnet-4-20250514', priority: 2 },
          ],
        },
      }],
    });
    // Update with filtered routing_config
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1 });
    // COMMIT
    mockClientQuery.mockResolvedValueOnce({});

    const res = await request(app)
      .delete(`/provider-connections/${deletedConnId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    // Verify update was called with filtered config (only 'keep' route remains)
    // Calls: BEGIN, DELETE, SELECT, UPDATE, COMMIT → UPDATE is index 3
    const updateCall = mockClientQuery.mock.calls[3];
    const updatedConfig = JSON.parse(updateCall[1][0]);
    expect(updatedConfig.routes).toHaveLength(1);
    expect(updatedConfig.routes[0].key).toBe('keep');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  // F2: DELETE removes default_route → model deactivated
  it('F2: DELETE removes default_route → model deactivated', async () => {
    const deletedConnId = 'conn-default';
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: deletedConnId }] }); // DELETE
    mockClientQuery.mockResolvedValueOnce({
      rows: [{
        id: 'router-2',
        routing_config: {
          strategy: 'fallback',
          default_route: 'default-route',
          routes: [
            { key: 'default-route', connection_id: deletedConnId, litellm_model: 'openai/gpt-4o', priority: 1 },
            { key: 'backup', connection_id: 'conn-other', litellm_model: 'openai/gpt-4o-mini', priority: 2 },
          ],
        },
      }],
    }); // SELECT
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE
    mockClientQuery.mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .delete(`/provider-connections/${deletedConnId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    // Verify is_active = false was set (UPDATE is index 3)
    const updateCall = mockClientQuery.mock.calls[3];
    expect(updateCall[0]).toContain('is_active = false');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  // F3: DELETE removes last route → router deleted
  it('F3: DELETE removes last route → router deleted', async () => {
    const deletedConnId = 'conn-only';
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: deletedConnId }] }); // DELETE conn
    mockClientQuery.mockResolvedValueOnce({
      rows: [{
        id: 'router-3',
        routing_config: {
          strategy: 'fallback',
          default_route: 'only',
          routes: [
            { key: 'only', connection_id: deletedConnId, litellm_model: 'openai/gpt-4o', priority: 1 },
          ],
        },
      }],
    }); // SELECT
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1 }); // DELETE router model
    mockClientQuery.mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .delete(`/provider-connections/${deletedConnId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    // Verify DELETE was called on the router model (index 3)
    const deleteCall = mockClientQuery.mock.calls[3];
    expect(deleteCall[0]).toContain('DELETE FROM user_models');
    expect(deleteCall[1]).toEqual(['router-3']);
    expect(mockClientRelease).toHaveBeenCalled();
  });

  // F4: DELETE with connection_id in 2 routes of same router
  it('F4: DELETE removes both routes referencing same connection', async () => {
    const deletedConnId = 'conn-multi';
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: deletedConnId }] }); // DELETE
    mockClientQuery.mockResolvedValueOnce({
      rows: [{
        id: 'router-4',
        routing_config: {
          strategy: 'fallback',
          default_route: 'keeper',
          routes: [
            { key: 'route-a', connection_id: deletedConnId, litellm_model: 'openai/gpt-4o', priority: 1 },
            { key: 'route-b', connection_id: deletedConnId, litellm_model: 'openai/gpt-4o-mini', priority: 2 },
            { key: 'keeper', connection_id: 'conn-other', litellm_model: 'anthropic/claude-sonnet-4-20250514', priority: 3 },
          ],
        },
      }],
    }); // SELECT
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE
    mockClientQuery.mockResolvedValueOnce({}); // COMMIT

    const res = await request(app)
      .delete(`/provider-connections/${deletedConnId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    const updateCall = mockClientQuery.mock.calls[3];
    const updatedConfig = JSON.parse(updateCall[1][0]);
    expect(updatedConfig.routes).toHaveLength(1);
    expect(updatedConfig.routes[0].key).toBe('keeper');
    expect(mockClientRelease).toHaveBeenCalled();
  });

  // F5: DELETE connection with JSONB cascade failure → 500, connection NOT deleted (rolled back)
  it('F5: DELETE with cascade failure returns 500 and rolls back', async () => {
    const connId = 'conn-cascade-fail';
    mockClientQuery.mockResolvedValueOnce({}); // BEGIN
    mockClientQuery.mockResolvedValueOnce({ rows: [{ id: connId }] }); // DELETE
    // Router model SELECT throws an error (cascade failure)
    mockClientQuery.mockRejectedValueOnce(new Error('DB read failure'));
    // ROLLBACK (called in catch)
    mockClientQuery.mockResolvedValueOnce({});

    const res = await request(app)
      .delete(`/provider-connections/${connId}`)
      .set('Authorization', `Bearer ${userToken}`);

    // Should return 500, NOT 200 — the connection delete must be rolled back
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/cascade/i);

    // Verify ROLLBACK was called
    const rollbackCall = mockClientQuery.mock.calls.find(
      (call: any[]) => call[0] === 'ROLLBACK'
    );
    expect(rollbackCall).toBeDefined();
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
