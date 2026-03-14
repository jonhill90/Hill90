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

// Mock docker service (required by agents router)
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  resolveAgentNetwork: jest.fn().mockReturnValue('hill90_agent_sandbox'),
  AGENT_NETWORK: 'hill90_agent_internal',
  AGENT_SANDBOX_NETWORK: 'hill90_agent_sandbox',
}));
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));
jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
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

describe('Container Profiles routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // CP-1: GET /container-profiles returns seeded standard profile
  it('GET /container-profiles returns profile list for authenticated user', async () => {
    const standardProfile = {
      id: 'profile-uuid-1',
      name: 'standard',
      description: 'Standard agentbox runtime',
      docker_image: 'hill90/agentbox:latest',
      default_cpus: '1.0',
      default_mem_limit: '1g',
      default_pids_limit: 200,
      is_platform: true,
      created_at: '2026-03-14T00:00:00Z',
      updated_at: '2026-03-14T00:00:00Z',
    };
    mockQuery.mockResolvedValueOnce({ rows: [standardProfile] });

    const res = await request(app)
      .get('/container-profiles')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('standard');
    expect(res.body[0].docker_image).toBe('hill90/agentbox:latest');
    expect(res.body[0].is_platform).toBe(true);
  });

  // CP-2: GET /container-profiles rejects unauthenticated request
  it('GET /container-profiles returns 401 without auth', async () => {
    const res = await request(app).get('/container-profiles');
    expect(res.status).toBe(401);
  });
});
