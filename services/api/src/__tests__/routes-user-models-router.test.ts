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

const userToken = makeToken('regular-user', ['user']);

function validRoutingConfig(overrides?: Partial<any>) {
  return {
    strategy: 'fallback',
    default_route: 'primary',
    routes: [
      {
        key: 'primary',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
        priority: 1,
      },
      {
        key: 'fallback',
        connection_id: 'conn-2',
        litellm_model: 'anthropic/claude-sonnet-4-20250514',
        priority: 2,
      },
    ],
    ...overrides,
  };
}

describe('User Models Router CRUD', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // A1: POST single model unchanged
  it('A1: POST single model unchanged', async () => {
    // Connection ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'my-gpt4', connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o', description: '', is_active: true,
        model_type: 'single', detected_type: 'chat', capabilities: ['chat', 'function_calling', 'vision'],
        routing_config: null, icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-gpt4',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(201);
    expect(res.body.connection_id).toBe('conn-1');
    expect(res.body.litellm_model).toBe('openai/gpt-4o');
  });

  // A2: POST router with valid routing_config
  it('A2: POST router with valid routing_config', async () => {
    // Route connection ownership check (batch query)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }, { id: 'conn-2' }] });
    // Platform collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-router', name: 'Multi Router', connection_id: null,
        litellm_model: null, description: '', is_active: true,
        model_type: 'router', detected_type: null, capabilities: null,
        routing_config: validRoutingConfig(), icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Multi Router',
        model_type: 'router',
        routing_config: validRoutingConfig(),
      });

    expect(res.status).toBe(201);
    expect(res.body.model_type).toBe('router');
  });

  // A3: POST router missing routing_config
  it('A3: POST router missing routing_config', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Bad Router',
        model_type: 'router',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('routing_config');
  });

  // A4: POST router with non-owned connection_id in route
  it('A4: POST router with non-owned connection_id in route', async () => {
    // Route connection ownership check — only conn-1 owned
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Bad Router',
        model_type: 'router',
        routing_config: validRoutingConfig(),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not owned by you');
  });

  // A5: POST router with connection_id/litellm_model set
  it('A5: POST router with connection_id/litellm_model set', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Bad Router',
        model_type: 'router',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
        routing_config: validRoutingConfig(),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must not have connection_id');
  });

  // A6: POST single with routing_config set
  it('A6: POST single with routing_config set', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Bad Single',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
        routing_config: validRoutingConfig(),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must not have routing_config');
  });

  // A7: PUT single → router
  it('A7: PUT single → router', async () => {
    // Ownership check (returns current model_type)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', model_type: 'single' }] });
    // Route connection ownership check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }, { id: 'conn-2' }] });
    // Update
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'Upgraded Router', connection_id: null,
        litellm_model: null, description: '', is_active: true,
        model_type: 'router', detected_type: null, capabilities: null,
        routing_config: validRoutingConfig(), icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        model_type: 'router',
        routing_config: validRoutingConfig(),
      });

    expect(res.status).toBe(200);
    expect(res.body.model_type).toBe('router');
  });

  // A8: PUT router → single
  it('A8: PUT router → single', async () => {
    // Ownership check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'model-1', model_type: 'router' }] });
    // Connection ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Update
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'Downgraded', connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o', description: '', is_active: true,
        model_type: 'single', detected_type: 'chat', capabilities: ['chat', 'function_calling', 'vision'],
        routing_config: null, icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .put('/user-models/model-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        model_type: 'single',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(200);
    expect(res.body.model_type).toBe('single');
  });

  // A9: POST router invalid strategy
  it('A9: POST router invalid strategy', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Bad Strategy',
        model_type: 'router',
        routing_config: validRoutingConfig({ strategy: 'round_robin' }),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('strategy');
  });

  // A10: POST router default_route not in routes
  it('A10: POST router default_route not in routes', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Bad Default',
        model_type: 'router',
        routing_config: validRoutingConfig({ default_route: 'nonexistent' }),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('default_route');
  });

  // A11: POST router duplicate route keys
  it('A11: POST router duplicate route keys', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Dup Keys',
        model_type: 'router',
        routing_config: {
          strategy: 'fallback',
          default_route: 'primary',
          routes: [
            { key: 'primary', connection_id: 'conn-1', litellm_model: 'openai/gpt-4o', priority: 1 },
            { key: 'primary', connection_id: 'conn-2', litellm_model: 'openai/gpt-4o-mini', priority: 2 },
          ],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Duplicate route key');
  });

  // A12: POST single auto-detects type from litellm_model
  it('A12: POST single auto-detects type from litellm_model', async () => {
    // Connection ownership
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    // Platform collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert — check the params passed
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'gpt4', connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o', description: '', is_active: true,
        model_type: 'single', detected_type: 'chat',
        capabilities: ['chat', 'function_calling', 'vision'],
        routing_config: null, icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'gpt4',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(201);
    // Verify the INSERT included detected_type
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain('detected_type');
    // Param 5 (index 4) should be 'chat'
    expect(insertCall[1][4]).toBe('chat');
  });

  // A13: POST single manual override of detected_type
  it('A13: POST single manual override of detected_type', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'custom', connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o', description: '', is_active: true,
        model_type: 'single', detected_type: 'custom_type',
        capabilities: ['custom_cap'],
        routing_config: null, icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'custom',
        connection_id: 'conn-1',
        litellm_model: 'openai/gpt-4o',
        detected_type: 'custom_type',
        capabilities: ['custom_cap'],
      });

    expect(res.status).toBe(201);
    // Verify override was used
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[1][4]).toBe('custom_type');
    expect(insertCall[1][5]).toEqual(['custom_cap']);
  });

  // A14: POST router routes get per-route detected_type
  it('A14: POST router routes get per-route detected_type', async () => {
    // Route connection ownership — both owned
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }, { id: 'conn-2' }] });
    // Platform collision
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Insert — capture the routing_config JSON
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'router-1', name: 'Enriched Router', connection_id: null,
        litellm_model: null, description: '', is_active: true,
        model_type: 'router', detected_type: null, capabilities: null,
        routing_config: {}, icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const config = {
      strategy: 'fallback',
      default_route: 'embed',
      routes: [
        { key: 'embed', connection_id: 'conn-1', litellm_model: 'openai/text-embedding-3-small', priority: 1 },
        { key: 'chat', connection_id: 'conn-2', litellm_model: 'openai/gpt-4o', priority: 2 },
      ],
    };

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Enriched Router',
        model_type: 'router',
        routing_config: config,
      });

    expect(res.status).toBe(201);
    // Verify the INSERT passed enriched routing_config with detected_type per route
    const insertCall = mockQuery.mock.calls[2];
    const insertedConfig = JSON.parse(insertCall[1][1]);
    expect(insertedConfig.routes[0].detected_type).toBe('embedding');
    expect(insertedConfig.routes[1].detected_type).toBe('chat');
    expect(insertedConfig.routes[1].capabilities).toEqual(['chat', 'function_calling', 'vision']);
  });

  // A15: POST embedding model auto-detected
  it('A15: POST embedding model auto-detected', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'conn-1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'model-1', name: 'embedder', connection_id: 'conn-1',
        litellm_model: 'openai/text-embedding-3-small', description: '', is_active: true,
        model_type: 'single', detected_type: 'embedding',
        capabilities: ['embedding'],
        routing_config: null, icon_emoji: null, icon_url: null,
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
    });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'embedder',
        connection_id: 'conn-1',
        litellm_model: 'openai/text-embedding-3-small',
      });

    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[1][4]).toBe('embedding');
    expect(insertCall[1][5]).toEqual(['embedding']);
  });
});
