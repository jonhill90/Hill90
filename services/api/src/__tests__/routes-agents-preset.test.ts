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

const developerPresetConfig = {
  shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /'], max_timeout: 300 },
  filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
  health: { enabled: true },
};

const defaultToolsConfig = {
  shell: { enabled: false },
  filesystem: { enabled: false },
  health: { enabled: true },
};

const agentRow = {
  id: 'uuid-1',
  agent_id: 'test-agent',
  name: 'Test Agent',
  description: '',
  status: 'stopped',
  tools_config: JSON.stringify(defaultToolsConfig),
  cpus: '1.0',
  mem_limit: '1g',
  pids_limit: 200,
  soul_md: '',
  rules_md: '',
  model_policy_id: null,
  tool_preset_id: null,
  created_by: 'regular-user',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('Agent POST tool_preset_id behavior', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // T13: Agent create with preset resolves tools_config
  it('create agent with tool_preset_id copies preset config', async () => {
    // Preset lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'preset-dev', tools_config: developerPresetConfig }],
    });
    // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...agentRow,
        id: 'uuid-new',
        tool_preset_id: 'preset-dev',
        tools_config: developerPresetConfig,
      }],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        tool_preset_id: 'preset-dev',
      });

    expect(res.status).toBe(201);
    expect(res.body.tool_preset_id).toBe('preset-dev');
    // Verify the INSERT used the preset's tools_config, not the default
    const insertCall = mockQuery.mock.calls[1];
    const toolsConfigParam = insertCall[1][3]; // tools_config is 4th param ($4)
    const parsed = JSON.parse(toolsConfigParam);
    expect(parsed.shell.enabled).toBe(true);
    expect(parsed.shell.allowed_binaries).toContain('bash');
    expect(parsed.shell.allowed_binaries).toContain('git');
  });

  // T14: Agent create with invalid preset rejected
  it('create agent with nonexistent preset returns 400', async () => {
    // Preset lookup returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        tool_preset_id: 'nonexistent-preset',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Tool preset not found');
  });

  // T16: Agent create without preset uses default tools_config
  it('create agent without preset uses default', async () => {
    // No preset lookup needed — just INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...agentRow,
        id: 'uuid-new',
        tool_preset_id: null,
      }],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
      });

    expect(res.status).toBe(201);
    expect(res.body.tool_preset_id).toBeNull();
    // Verify default tools_config was used in INSERT
    const insertCall = mockQuery.mock.calls[0];
    const toolsConfigParam = insertCall[1][3];
    const parsed = JSON.parse(toolsConfigParam);
    expect(parsed.shell.enabled).toBe(false);
    expect(parsed.filesystem.enabled).toBe(false);
    expect(parsed.health.enabled).toBe(true);
  });
});

describe('Agent PUT tool_preset_id behavior', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // T15: Agent update with preset resolves tools_config
  it('update agent tool_preset_id copies preset config', async () => {
    // Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // Preset lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'preset-dev', tools_config: developerPresetConfig }],
    });
    // UPDATE
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, tool_preset_id: 'preset-dev', tools_config: developerPresetConfig }],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ tool_preset_id: 'preset-dev' });

    expect(res.status).toBe(200);
    expect(res.body.tool_preset_id).toBe('preset-dev');
    // Verify the UPDATE set both tool_preset_id and tools_config from preset
    const updateCall = mockQuery.mock.calls[2];
    // tools_config param should be the preset's config (not null/COALESCE)
    const toolsConfigParam = updateCall[1][2]; // $3 is tools_config
    const parsed = JSON.parse(toolsConfigParam);
    expect(parsed.shell.enabled).toBe(true);
    expect(parsed.shell.allowed_binaries).toContain('bash');
  });

  // T17: Agent update clears preset (set null)
  it('update agent tool_preset_id to null preserves tools_config', async () => {
    const agentWithPreset = {
      ...agentRow,
      tool_preset_id: 'preset-dev',
      tools_config: developerPresetConfig,
    };
    // Ownership check returns agent with preset
    mockQuery.mockResolvedValueOnce({ rows: [agentWithPreset] });
    // UPDATE — no preset lookup needed when clearing
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentWithPreset, tool_preset_id: null }],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ tool_preset_id: null });

    expect(res.status).toBe(200);
    // tool_preset_id should be cleared but tools_config should be preserved
    // (no tools_config in body means COALESCE keeps existing)
  });

  it('update agent with nonexistent preset returns 400', async () => {
    // Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // Preset lookup returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ tool_preset_id: 'nonexistent-preset' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Tool preset not found');
  });

  it('update agent without tool_preset_id does not touch it', async () => {
    // Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, name: 'Updated Name' }] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });
});
