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

const userToken = makeToken('user-a', ['user']);

describe('Router Connection Validation — H1-H5', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // H1: POST router with non-existent route connection_id → 400
  it('H1: POST router with non-existent route connection_id returns 400', async () => {
    // validateRouteConnectionOwnership: SELECT id FROM provider_connections WHERE id IN (...) AND created_by = $2
    // Returns empty — connection not found
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'My Router',
        model_type: 'router',
        routing_config: {
          strategy: 'fallback',
          default_route: 'route-1',
          routes: [
            { key: 'route-1', connection_id: 'non-existent-conn', litellm_model: 'openai/gpt-4o', priority: 1 },
          ],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not owned/i);
  });

  // H2: POST router with cross-user route connection_id → 400
  it('H2: POST router with cross-user route connection_id returns 400', async () => {
    // Owner query returns empty (connection belongs to another user)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Cross-User Router',
        model_type: 'router',
        routing_config: {
          strategy: 'fallback',
          default_route: 'route-1',
          routes: [
            { key: 'route-1', connection_id: 'user-b-conn', litellm_model: 'openai/gpt-4o', priority: 1 },
          ],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not owned/i);

    // Verify the ownership query was scoped to user-a
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('provider_connections'),
      expect.arrayContaining(['user-a'])
    );
  });

  // H3: PUT router with non-existent route connection_id → 400
  it('H3: PUT router with non-existent route connection_id returns 400', async () => {
    // Verify ownership of model (existing model found)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', model_type: 'router' }] });
    // validateRouteConnectionOwnership returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        routing_config: {
          strategy: 'fallback',
          default_route: 'route-1',
          routes: [
            { key: 'route-1', connection_id: 'non-existent-conn', litellm_model: 'openai/gpt-4o', priority: 1 },
          ],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not owned/i);
  });

  // H4: POST router with mixed valid/invalid connection_ids → 400 (entire request rejected)
  it('H4: POST router with mixed valid/invalid connection_ids returns 400', async () => {
    // validateRouteConnectionOwnership: returns only valid-conn (not invalid-conn)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'valid-conn' }] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Mixed Router',
        model_type: 'router',
        routing_config: {
          strategy: 'fallback',
          default_route: 'route-1',
          routes: [
            { key: 'route-1', connection_id: 'valid-conn', litellm_model: 'openai/gpt-4o', priority: 1 },
            { key: 'route-2', connection_id: 'invalid-conn', litellm_model: 'anthropic/claude-sonnet-4-20250514', priority: 2 },
          ],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not owned/i);
  });

  // H5: POST router with all valid connection_ids → 201 (happy path)
  it('H5: POST router with all valid connection_ids returns 201', async () => {
    // validateRouteConnectionOwnership: all connections owned
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }, { id: 'conn-2' }] });
    // Platform model collision check
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT returning
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'new-router',
        name: 'Valid Router',
        connection_id: null,
        litellm_model: null,
        description: '',
        is_active: true,
        model_type: 'router',
        detected_type: null,
        capabilities: null,
        routing_config: { strategy: 'fallback', default_route: 'route-1', routes: [] },
        icon_emoji: null,
        icon_url: null,
        created_at: '2026-03-22T00:00:00Z',
        updated_at: '2026-03-22T00:00:00Z',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Valid Router',
        model_type: 'router',
        routing_config: {
          strategy: 'fallback',
          default_route: 'route-1',
          routes: [
            { key: 'route-1', connection_id: 'conn-1', litellm_model: 'openai/gpt-4o', priority: 1 },
            { key: 'route-2', connection_id: 'conn-2', litellm_model: 'anthropic/claude-sonnet-4-20250514', priority: 2 },
          ],
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('new-router');
  });
});
