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

const userToken = makeToken('user-a', ['user']);

describe('Orphan prevention — user models require valid connection', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgres://fake';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('G1: POST /user-models without connection_id returns 400', async () => {
    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'my-model', litellm_model: 'openai/gpt-4o' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name, connection_id, and litellm_model are required');
  });

  it('G2: POST /user-models with non-existent connection_id returns 400', async () => {
    // Mock: connection ownership query returns empty rows
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-model',
        connection_id: '00000000-0000-0000-0000-000000000000',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not owned by you/);

    // Verify the ownership query was called with correct params
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT id FROM provider_connections WHERE id = $1 AND created_by = $2',
      ['00000000-0000-0000-0000-000000000000', 'user-a']
    );
  });

  it('G3: POST /user-models with another user\'s connection_id returns 400', async () => {
    // Mock: connection ownership query scoped to user-a returns empty rows
    // (because the connection belongs to user-b)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/user-models')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'my-model',
        connection_id: 'user-b-connection-id',
        litellm_model: 'openai/gpt-4o',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found or not owned by you/);

    // Verify the ownership query was scoped to user-a (the requester), not user-b
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT id FROM provider_connections WHERE id = $1 AND created_by = $2',
      ['user-b-connection-id', 'user-a']
    );
  });
});
