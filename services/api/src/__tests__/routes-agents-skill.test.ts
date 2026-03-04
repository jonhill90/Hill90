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

const devToolsConfig = {
  shell: { enabled: true, allowed_binaries: ['bash', 'git', 'make', 'curl', 'jq'], denied_patterns: ['rm -rf /'], max_timeout: 300 },
  filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/data'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
  health: { enabled: true },
};

const minToolsConfig = {
  shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 120 },
  filesystem: { enabled: true, read_only: true, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
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
    // 1. Skill batch lookup (WHERE id = ANY($1::uuid[]))
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-dev', tools_config: devToolsConfig, scope: 'container_local' }],
    });
    // 2. INSERT agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, id: 'uuid-new', tools_config: devToolsConfig }],
    });
    // 3. INSERT agent_skills (1 skill)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. SELECT skills for response
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

  // R6: Create agent with 2 skills — merged tools_config
  it('create agent with 2 skills merges tools_config', async () => {
    // 1. Skill batch lookup returns 2 skills
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'skill-1', tools_config: devToolsConfig, scope: 'container_local' },
        { id: 'skill-2', tools_config: minToolsConfig, scope: 'container_local' },
      ],
    });
    // 2. INSERT agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, id: 'uuid-multi' }],
    });
    // 3. INSERT agent_skills (skill-1)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. INSERT agent_skills (skill-2)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 5. SELECT skills for response
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'skill-1', name: 'Developer', scope: 'container_local' },
        { id: 'skill-2', name: 'Reader', scope: 'container_local' },
      ],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        skill_ids: ['skill-1', 'skill-2'],
      });

    expect(res.status).toBe(201);
    expect(res.body.skills).toHaveLength(2);

    // Verify merged tools_config: shell.enabled OR → true, filesystem.read_only AND → false
    const insertCall = mockQuery.mock.calls[1];
    const parsed = JSON.parse(insertCall[1][3]);
    expect(parsed.shell.enabled).toBe(true); // OR: true || false
    expect(parsed.filesystem.enabled).toBe(true); // OR: true || true
    expect(parsed.filesystem.read_only).toBe(false); // AND: false && true → false
    expect(parsed.shell.max_timeout).toBe(300); // MAX(300, 120)
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
    // Skill batch lookup returns fewer than requested
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
    expect(res.body.error).toContain('not found');
  });

  // T11: Agent create without skill uses default tools_config
  it('create agent without skill_ids uses default', async () => {
    // 1. INSERT agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, id: 'uuid-new' }],
    });
    // 2. SELECT skills for response (empty)
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
    // 1. Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. Skill batch lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-dev', tools_config: devToolsConfig, scope: 'container_local' }],
    });
    // 3. Current agent_skills for elevated-removal check (user is non-admin)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. UPDATE agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, tools_config: devToolsConfig }],
    });
    // 5. DELETE agent_skills
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    // 6. INSERT agent_skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7. SELECT skills for response
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

  // R9: PUT agents empty skill_ids clears skills (Custom mode)
  it('update agent skill_ids to empty clears skill', async () => {
    // 1. Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. Current agent_skills for elevated-removal check (user is non-admin)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3. UPDATE agent (no skill lookup since skill_ids is empty)
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 4. DELETE agent_skills
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // 5. SELECT skills for response (empty)
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

  it('update agent without skill_ids does not touch skills', async () => {
    // 1. Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. UPDATE agent (no skill lookup since skill_ids not provided)
    mockQuery.mockResolvedValueOnce({ rows: [{ ...agentRow, name: 'Updated Name' }] });
    // 3. SELECT skills for response
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });
});

// T15: Create agent with elevated skill_ids rejected for non-admin
describe('Agent create/update scope RBAC', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it('create with host_docker skill as non-admin returns 403', async () => {
    // Skill batch lookup returns host_docker scope
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-docker', tools_config: devToolsConfig, scope: 'host_docker' }],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        skill_ids: ['skill-docker'],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host_docker');
    expect(res.body.error).toContain('admin');
  });

  it('create with host_docker skill as admin succeeds', async () => {
    // 1. Skill batch lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-docker', tools_config: devToolsConfig, scope: 'host_docker' }],
    });
    // 2. INSERT agent
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, id: 'uuid-admin' }],
    });
    // 3. INSERT agent_skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. SELECT skills for response
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-docker', name: 'Docker Access', scope: 'host_docker' }],
    });

    const res = await request(app)
      .post('/agents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agent_id: 'test-agent',
        name: 'Test Agent',
        skill_ids: ['skill-docker'],
      });

    expect(res.status).toBe(201);
    expect(res.body.skills[0].scope).toBe('host_docker');
  });

  // T16: Update agent with elevated skill_ids rejected for non-admin
  it('update with vps_system skill as non-admin returns 403', async () => {
    // 1. Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. Skill batch lookup returns vps_system scope
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-vps', tools_config: devToolsConfig, scope: 'vps_system' }],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_ids: ['skill-vps'] });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('vps_system');
    expect(res.body.error).toContain('admin');
  });

  it('update with vps_system skill as admin succeeds', async () => {
    // 1. Ownership check (admin sees all)
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. Skill batch lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-vps', tools_config: devToolsConfig, scope: 'vps_system' }],
    });
    // 3. UPDATE agent (admin skips elevated-removal check)
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, tools_config: devToolsConfig }],
    });
    // 4. DELETE agent_skills
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    // 5. INSERT agent_skills
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 6. SELECT skills for response
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-vps', name: 'VPS Access', scope: 'vps_system' }],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ skill_ids: ['skill-vps'] });

    expect(res.status).toBe(200);
    expect(res.body.skills[0].scope).toBe('vps_system');
  });

  // R7: PUT removing elevated skill as non-admin → 403
  it('update removing elevated skill as non-admin returns 403', async () => {
    // 1. Ownership check returns agent
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. Skill batch lookup for new skill_ids (container_local only)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-basic', tools_config: minToolsConfig, scope: 'container_local' }],
    });
    // 3. Current agent_skills — has an elevated skill being removed
    mockQuery.mockResolvedValueOnce({
      rows: [
        { skill_id: 'skill-basic', scope: 'container_local' },
        { skill_id: 'skill-docker', scope: 'host_docker' },
      ],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_ids: ['skill-basic'] }); // implicitly removes skill-docker

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host_docker');
    expect(res.body.error).toContain('admin');
  });

  // R8: PUT removing elevated skill as admin → 200
  it('update removing elevated skill as admin succeeds', async () => {
    // 1. Ownership check (admin sees all)
    mockQuery.mockResolvedValueOnce({ rows: [agentRow] });
    // 2. Skill batch lookup for new skill_ids
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-basic', tools_config: minToolsConfig, scope: 'container_local' }],
    });
    // 3. UPDATE agent (admin skips elevated-removal check)
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, tools_config: minToolsConfig }],
    });
    // 4. DELETE agent_skills
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });
    // 5. INSERT agent_skills (1 skill)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 6. SELECT skills for response
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'skill-basic', name: 'Basic', scope: 'container_local' }],
    });

    const res = await request(app)
      .put('/agents/uuid-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ skill_ids: ['skill-basic'] }); // implicitly removes elevated skill

    expect(res.status).toBe(200);
    expect(res.body.skills).toHaveLength(1);
    expect(res.body.skills[0].id).toBe('skill-basic');
  });
});

// Agent start with skills
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
    // 2. SELECT skill instructions from agent_skills JOIN skills (single skill)
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: 'Developer', instructions_md: 'You have full developer access.' }],
    });
    // 3+. UPDATE agent status queries
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(writeAgentFiles).toHaveBeenCalledTimes(1);
    const callArgs = writeAgentFiles.mock.calls[0];
    // Single skill: composed with ## Skill: header
    expect(callArgs[1]).toBe('## Skill: Developer\n\nYou have full developer access.');
  });

  // R10: Start agent with multiple skills composes instructions
  it('start agent with 2 skills composes instructions with headers', async () => {
    const agentStopped = { ...agentRow, status: 'stopped' };

    const { createAndStartContainer } = jest.requireMock('../services/docker') as any;
    createAndStartContainer.mockResolvedValue('container-multi');

    // 1. SELECT agent
    mockQuery.mockResolvedValueOnce({ rows: [agentStopped] });
    // 2. SELECT skill instructions (2 skills, ordered by assigned_at ASC)
    mockQuery.mockResolvedValueOnce({
      rows: [
        { name: 'Developer', instructions_md: 'You have shell access.' },
        { name: 'Data Reader', instructions_md: 'You can read /data.' },
      ],
    });
    // 3+. UPDATE agent status queries
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/agents/uuid-1/start')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(writeAgentFiles).toHaveBeenCalledTimes(1);
    const callArgs = writeAgentFiles.mock.calls[0];
    const expected = [
      '## Skill: Developer',
      '',
      'You have shell access.',
      '',
      '---',
      '',
      '## Skill: Data Reader',
      '',
      'You can read /data.',
    ].join('\n');
    expect(callArgs[1]).toBe(expected);
  });

  // Start with skill that has no instructions
  it('start agent with skill having no instructions writes undefined', async () => {
    const agentStopped = { ...agentRow, status: 'stopped' };

    const { createAndStartContainer } = jest.requireMock('../services/docker') as any;
    createAndStartContainer.mockResolvedValue('container-no-instr');

    // 1. SELECT agent
    mockQuery.mockResolvedValueOnce({ rows: [agentStopped] });
    // 2. SELECT skill instructions (skill with null instructions_md)
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: 'Silent', instructions_md: null }],
    });
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
