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

const AGENT_ID = '00000000-0000-0000-0000-000000000001';
const SKILL_CONTAINER = '00000000-0000-0000-0000-000000000010';
const SKILL_HOST_DOCKER = '00000000-0000-0000-0000-000000000020';
const SKILL_VPS_SYSTEM = '00000000-0000-0000-0000-000000000030';

const stoppedAgent = { id: AGENT_ID, status: 'stopped' };
const runningAgent = { id: AGENT_ID, status: 'running' };

const devToolsConfig = {
  shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: [], max_timeout: 300 },
  filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
  health: { enabled: true },
};
const containerSkill = { id: SKILL_CONTAINER, scope: 'container_local', tools_config: devToolsConfig };
const hostDockerSkill = { id: SKILL_HOST_DOCKER, scope: 'host_docker', tools_config: devToolsConfig };
const vpsSystemSkill = { id: SKILL_VPS_SYSTEM, scope: 'vps_system', tools_config: devToolsConfig };

const assignmentRecord = {
  agent_id: AGENT_ID,
  skill_id: SKILL_CONTAINER,
  assigned_at: '2026-03-02T00:00:00Z',
  assigned_by: 'regular-user',
};

describe('Agent skill assignment endpoints', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // -----------------------------------------------------------------------
  // POST /agents/:id/skills
  // -----------------------------------------------------------------------

  // T1: Assign skill to agent
  it('POST /agents/:id/skills assigns skill to agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup (user scope)
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 0 })            // delete existing
      .mockResolvedValueOnce({ rows: [assignmentRecord] }) // insert
      .mockResolvedValueOnce({ rowCount: 1 });            // update agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(res.body.skill_id).toBe(SKILL_CONTAINER);
  });

  // T10: Replace semantics — assigning new skill replaces existing
  it('POST /agents/:id/skills replaces existing skill (max 1)', async () => {
    const newSkillId = '00000000-0000-0000-0000-000000000099';
    const newToolsConfig = { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } };
    const newAssignment = { ...assignmentRecord, skill_id: newSkillId };
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [{ id: newSkillId, scope: 'container_local', tools_config: newToolsConfig }] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 1 })            // delete existing (had one)
      .mockResolvedValueOnce({ rows: [newAssignment] })  // insert new
      .mockResolvedValueOnce({ rowCount: 1 });           // update agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: newSkillId });

    expect(res.status).toBe(201);
    expect(res.body.skill_id).toBe(newSkillId);
  });

  // T10b: POST /agents/:id/skills resolves tools_config on assign
  it('POST /agents/:id/skills resolves tools_config into agent (resolve-on-save)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup (includes tools_config)
      .mockResolvedValueOnce({ rowCount: 0 })            // delete existing
      .mockResolvedValueOnce({ rows: [assignmentRecord] }) // insert
      .mockResolvedValueOnce({ rowCount: 1 });            // update agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(201);

    // Verify the UPDATE agents query was called with the skill's tools_config
    expect(mockQuery).toHaveBeenCalledTimes(5);
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[0]).toContain('UPDATE agents');
    expect(updateCall[0]).toContain('tools_config');
    expect(updateCall[1][0]).toBe(JSON.stringify(devToolsConfig));
    expect(updateCall[1][1]).toBe(AGENT_ID);
  });

  // T4: User can assign container_local skill
  it('POST /agents/:id/skills user assigns container_local', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [containerSkill] })
      .mockResolvedValueOnce({ rowCount: 0 })            // delete existing
      .mockResolvedValueOnce({ rows: [assignmentRecord] })
      .mockResolvedValueOnce({ rowCount: 1 });            // update agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(201);
  });

  // T5: Non-admin gets 403 for host_docker
  it('POST /agents/:id/skills user host_docker 403', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [hostDockerSkill] });

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_HOST_DOCKER });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host_docker');
  });

  // T6: Non-admin gets 403 for vps_system
  it('POST /agents/:id/skills user vps_system 403', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [vpsSystemSkill] });

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_VPS_SYSTEM });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('vps_system');
  });

  // T7: Admin can assign host_docker
  it('POST /agents/:id/skills admin host_docker OK', async () => {
    const adminAssignment = { ...assignmentRecord, skill_id: SKILL_HOST_DOCKER, assigned_by: 'admin-user' };
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })   // agent lookup (admin scope = 1=1)
      .mockResolvedValueOnce({ rows: [hostDockerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 0 })             // delete existing
      .mockResolvedValueOnce({ rows: [adminAssignment] }) // insert
      .mockResolvedValueOnce({ rowCount: 1 });            // update agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ skill_id: SKILL_HOST_DOCKER });

    expect(res.status).toBe(201);
  });

  // T8: Cannot assign to running agent
  it('POST /agents/:id/skills running agent 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runningAgent] });

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('running');
  });

  // Agent not found
  it('POST /agents/:id/skills agent not found 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Agent');
  });

  // Skill not found
  it('POST /agents/:id/skills skill not found 404', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [] }); // skill not found

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Skill');
  });

  // Missing skill_id
  it('POST /agents/:id/skills missing skill_id 400', async () => {
    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // DELETE /agents/:id/skills/:skillId
  // -----------------------------------------------------------------------

  // T3: Remove assignment
  it('DELETE /agents/:id/skills/:skillId removes assignment', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 1 });           // delete

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });

  // T10c: DELETE preserves tools_config — no UPDATE agents query
  it('DELETE /agents/:id/skills/:skillId preserves tools_config (no mutation)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 1 });           // delete

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);

    // Verify exactly 3 queries — no UPDATE agents for tools_config
    expect(mockQuery).toHaveBeenCalledTimes(3);
    // None of the 3 queries should be an UPDATE agents
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).not.toContain('UPDATE agents');
    }
  });

  // T9: Non-admin cannot remove host_docker skill
  it('DELETE /agents/:id/skills/:skillId user remove host_docker 403', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [hostDockerSkill] });

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_HOST_DOCKER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('host_docker');
  });

  // T10: Non-admin can remove container_local skill
  it('DELETE /agents/:id/skills/:skillId user remove container_local OK', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [containerSkill] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });

  // Assignment not found
  it('DELETE /agents/:id/skills/:skillId assignment not found 404', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [containerSkill] })
      .mockResolvedValueOnce({ rowCount: 0 }); // no row deleted

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('assignment');
  });

  // Cannot remove from running agent
  it('DELETE /agents/:id/skills/:skillId running agent 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [runningAgent] });

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('running');
  });

  // Admin can remove vps_system skill
  it('DELETE /agents/:id/skills/:skillId admin remove vps_system OK', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [vpsSystemSkill] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_VPS_SYSTEM}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });
});
