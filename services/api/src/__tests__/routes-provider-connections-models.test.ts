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

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
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
const userBToken = makeToken('user-b', ['user']);

describe('Provider Connections — Model Listing', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAxiosPost.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.MODEL_ROUTER_INTERNAL_SERVICE_TOKEN;
  });

  // B1: GET /:id/models valid connection
  it('B1: GET /:id/models returns model list', async () => {
    // Connection ownership lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    // AI service response
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        models: [
          { id: 'openai/gpt-4o', display_name: 'gpt-4o', detected_type: 'chat', capabilities: ['chat'] },
        ],
      },
    });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.provider).toBe('openai');
  });

  // B2: GET non-owned connection
  it('B2: GET non-owned connection returns 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/provider-connections/other-conn/models')
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(404);
  });

  // B3: AI service returns error
  it('B3: AI service error returns models:[] with error', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    mockAxiosPost.mockRejectedValueOnce({
      response: { data: { error: 'Invalid API key' } },
    });

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.error).toBe('Invalid API key');
  });

  // B4: AI service timeout
  it('B4: AI service timeout returns actionable error', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'conn-1', provider: 'openai',
        api_key_encrypted: Buffer.from('enc'), api_key_nonce: Buffer.from('nonce'),
        api_base_url: null,
      }],
    });

    mockAxiosPost.mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));

    const res = await request(app)
      .get('/provider-connections/conn-1/models')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.error).toContain('timeout');
  });
});
