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

const developerSkillConfig = {
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
  created_by: 'regular-user',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// T4: Agent create with skill_ids assigns skill
describe('Agent POST skill_ids behavior', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('create agent with skill_ids resolves tools_config', async () => {
    // Skill lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-dev', tools_config: developerSkillConfig }],
    });
    // INSERT agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, id: 'uuid-new', tools_config: developerSkillConfig }],
    });
    // INSERT agent_skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-dev', name: 'Developer', scope: 'container_local' }],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        skill_ids: ['skill-dev'],
      });

    expect(res.status).toBe(201);
    expect(res.body.skills).toHaveLength(1);
    expect(res.body.skills[0].id).toBe('skill-dev');
    // Verify the INSERT used the skill's tools_config
    const insertCall = mockQuery.mock.calls[1];
    const toolsConfigParam = insertCall[1][3]; // tools_config is 4th param
    const parsed = JSON.parse(toolsConfigParam);
    expect(parsed.shell.enabled).toBe(true);
    expect(parsed.shell.allowed_binaries).toContain('bash');
  });

  // T5: skill_ids > 1 rejected
  it('create agent with skill_ids > 1 returns 400', async () => {
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        skill_ids: ['skill-1', 'skill-2'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum 1 skill');
  });

  // T12: tool_preset_id rejected
  it('create agent with tool_preset_id returns 400', async () => {
    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        tool_preset_id: 'some-id',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('deprecated');
  });

  it('create agent with nonexistent skill returns 400', async () => {
    // Skill lookup returns empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        skill_ids: ['nonexistent-skill'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Skill not found');
  });

  // T11: Agent create without skill uses default tools_config
  it('create agent without skill_ids uses default', async () => {
    // INSERT agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, id: 'uuid-new' }],
    });
    // SELECT skills for response (empty)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
      });

    expect(res.status).toBe(201);
    expect(res.body.skills).toHaveLength(0);
    // Verify default tools_config was used in INSERT
    const insertCall = mockQuery.mock.calls[0];
    const toolsConfigParam = insertCall[1][3];
    const parsed = JSON.parse(toolsConfigParam);
    expect(parsed.shell.enabled).toBe(false);
    expect(parsed.health.enabled).toBe(true);
  });
});

// T7: Agent update with skill_ids
describe('Agent PUT skill_ids behavior', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('update agent skill_ids resolves tools_config', async () => {
    // Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // Skill lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-dev', tools_config: developerSkillConfig }],
    });
    // UPDATE agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, tools_config: developerSkillConfig }],
    });
    // DELETE agent_skills
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    // INSERT agent_skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-dev', name: 'Developer', scope: 'container_local' }],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_ids: ['skill-dev'] });

    expect(res.status).toBe(200);
    expect(res.body.skills).toHaveLength(1);
    expect(res.body.skills[0].id).toBe('skill-dev');
  });

  it('update agent skill_ids to empty clears skill', async () => {
    // Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // UPDATE agent (no skill lookup needed)
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // DELETE agent_skills
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // SELECT skills for response (empty)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_ids: [] });

    expect(res.status).toBe(200);
    expect(res.body.skills).toHaveLength(0);
  });

  it('update agent with tool_preset_id returns 400', async () => {
    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ tool_preset_id: 'some-id' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('deprecated');
  });

  it('update agent with skill_ids > 1 returns 400', async () => {
    // Ownership check
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_ids: ['skill-1', 'skill-2'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum 1 skill');
  });

  it('update agent without skill_ids does not touch skills', async () => {
    // Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // UPDATE agent
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, name: 'Updated Name' }] });
    // SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });
});

// T10b: Agent start reads from agent_skills
const { writeAgentFiles } = jest.requireMock('../services/agent-files') as { writeAgentFiles: jest.Mock };

describe('Agent start reads from agent_skills', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    writeAgentFiles.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
  });

  it('start agent with skill fetches instructions from agent_skills JOIN', async () => {
    const agentStopped = { ...agentRow, status: 'stopped' };

    const { createAndStartContainer } = jest.requireMock('../services/docker') as any;
    createAndStartContainer.mockResolvedValue('container-123');

    // 1. SELECT agent
    mockQuery.mockResolvedValueOnce({ rows: [agentStopped] });
    // 2. SELECT instructions_md from agent_skills JOIN skills
    mockQuery.mockResolvedValueOnce({
      rows: [{ instructions_md: 'You have full developer access.' }],
    });
    // 3+. UPDATE agent status queries
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(writeAgentFiles).toHaveBeenCalledTimes(1);
    const callArgs = writeAgentFiles.mock.calls[0];
    expect(callArgs[1]).toBe('You have full developer access.');
  });

  // T11: Start without skill
  it('start agent without skill writes no instructions', async () => {
    const agentStopped = { ...agentRow, status: 'stopped' };

    const { createAndStartContainer } = jest.requireMock('../services/docker') as any;
    createAndStartContainer.mockResolvedValue('container-456');

    // 1. SELECT agent
    mockQuery.mockResolvedValueOnce({ rows: [agentStopped] });
    // 2. SELECT from agent_skills (empty — no skill assigned)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3+. UPDATE agent status queries
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(writeAgentFiles).toHaveBeenCalledTimes(1);
    const callArgs = writeAgentFiles.mock.calls[0];
    expect(callArgs[1]).toBeUndefined();
  });
});
