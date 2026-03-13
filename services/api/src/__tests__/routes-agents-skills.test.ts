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
const SKILL_CONTAINER_2 = '00000000-0000-0000-0000-000000000040';

const stoppedAgent = { id: AGENT_ID, status: 'stopped' };
const runningAgent = { id: AGENT_ID, status: 'running' };

const devToolsConfig = {
  shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: [], max_timeout: 300 },
  filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
  health: { enabled: true },
};

const minToolsConfig = {
  shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
  filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow', '/etc/passwd', '/root'] },
  health: { enabled: true },
};

const containerSkill = { id: SKILL_CONTAINER, scope: 'container_local', tools_config: devToolsConfig };
const containerSkill2 = { id: SKILL_CONTAINER_2, scope: 'container_local', tools_config: minToolsConfig };
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
  // POST /agents/:id/skills — additive semantics
  // -----------------------------------------------------------------------

  // R1: Assign skill to agent (additive, no DELETE all)
  it('POST /agents/:id/skills assigns skill additively', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup (user scope)
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rows: [assignmentRecord] }) // INSERT (additive)
      .mockResolvedValueOnce({ rows: [{ tools_config: devToolsConfig }] }) // SELECT all skills for merge
      .mockResolvedValueOnce({ rowCount: 1 });            // UPDATE agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(201);
    expect(res.body.agent_id).toBe(AGENT_ID);
    expect(res.body.skill_id).toBe(SKILL_CONTAINER);

    // Verify no DELETE FROM agent_skills was called
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).not.toContain('DELETE FROM agent_skills');
    }
  });

  // R2: POST duplicate skill returns 409
  it('POST /agents/:id/skills duplicate returns 409', async () => {
    const pkError = new Error('duplicate key value violates unique constraint') as any;
    pkError.code = '23505';

    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockRejectedValueOnce(pkError);                    // INSERT fails with PK violation

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already assigned');
  });

  // R3: POST merges tools_config from ALL skills for agent
  it('POST /agents/:id/skills merges tools_config from all skills', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rows: [assignmentRecord] }) // INSERT
      .mockResolvedValueOnce({                            // SELECT all skills for merge (2 skills now)
        rows: [
          { tools_config: devToolsConfig },
          { tools_config: minToolsConfig },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });            // UPDATE agents.tools_config

    const res = await request(app)
      .post(`/agents/${AGENT_ID}/skills`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ skill_id: SKILL_CONTAINER });

    expect(res.status).toBe(201);

    // Verify the UPDATE used a merged config
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[0]).toContain('UPDATE agents');
    const mergedConfig = JSON.parse(updateCall[1][0]);
    // OR: shell enabled because devToolsConfig has shell.enabled=true
    expect(mergedConfig.shell.enabled).toBe(true);
    // UNION allowed_paths: ['/workspace'] from both (deduped)
    expect(mergedConfig.filesystem.allowed_paths).toContain('/workspace');
  });

  // T4: User can assign container_local skill
  it('POST /agents/:id/skills user assigns container_local', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [containerSkill] })
      .mockResolvedValueOnce({ rows: [assignmentRecord] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ tools_config: devToolsConfig }] }) // SELECT all skills
      .mockResolvedValueOnce({ rowCount: 1 });            // UPDATE agents.tools_config

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
      .mockResolvedValueOnce({ rows: [adminAssignment] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ tools_config: devToolsConfig }] }) // SELECT all skills
      .mockResolvedValueOnce({ rowCount: 1 });            // UPDATE agents.tools_config

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
  // DELETE /agents/:id/skills/:skillId — recomputes tools_config
  // -----------------------------------------------------------------------

  // R4: DELETE recomputes tools_config from remaining skills
  it('DELETE /agents/:id/skills/:skillId recomputes tools_config from remaining', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 1 })            // DELETE
      .mockResolvedValueOnce({ rows: [{ tools_config: minToolsConfig }] }) // remaining skills
      .mockResolvedValueOnce({ rowCount: 1 });           // UPDATE agents.tools_config

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);

    // Verify UPDATE agents was called with remaining skill's config
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[0]).toContain('UPDATE agents');
    const updatedConfig = JSON.parse(updateCall[1][0]);
    expect(updatedConfig.shell.enabled).toBe(false);
    expect(updatedConfig.health.enabled).toBe(true);
  });

  // R5: DELETE last skill resets to no-skills default
  it('DELETE /agents/:id/skills/:skillId last skill resets to default', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })  // agent lookup
      .mockResolvedValueOnce({ rows: [containerSkill] }) // skill lookup
      .mockResolvedValueOnce({ rowCount: 1 })            // DELETE
      .mockResolvedValueOnce({ rows: [] })               // no remaining skills
      .mockResolvedValueOnce({ rowCount: 1 });           // UPDATE agents.tools_config

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_CONTAINER}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);

    // Verify UPDATE used default config (shell/fs disabled, health enabled)
    const updateCall = mockQuery.mock.calls[4];
    expect(updateCall[0]).toContain('UPDATE agents');
    const defaultConfig = JSON.parse(updateCall[1][0]);
    expect(defaultConfig.shell.enabled).toBe(false);
    expect(defaultConfig.filesystem.enabled).toBe(false);
    expect(defaultConfig.health.enabled).toBe(true);
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

  // Non-admin can remove container_local skill
  it('DELETE /agents/:id/skills/:skillId user remove container_local OK', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [stoppedAgent] })
      .mockResolvedValueOnce({ rows: [containerSkill] })
      .mockResolvedValueOnce({ rowCount: 1 })             // DELETE
      .mockResolvedValueOnce({ rows: [] })                 // remaining skills (empty)
      .mockResolvedValueOnce({ rowCount: 1 });             // UPDATE agents.tools_config

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
      .mockResolvedValueOnce({ rowCount: 1 })             // DELETE
      .mockResolvedValueOnce({ rows: [] })                 // remaining skills (empty)
      .mockResolvedValueOnce({ rowCount: 1 });             // UPDATE agents.tools_config

    const res = await request(app)
      .delete(`/agents/${AGENT_ID}/skills/${SKILL_VPS_SYSTEM}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Audit logging for elevated-scope operations
  // -----------------------------------------------------------------------

  describe('Audit logging', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    function getAuditCalls(): any[] {
      return consoleSpy.mock.calls
        .map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } })
        .filter((obj: any) => obj?.type === 'audit');
    }

    // T8: Skill assign elevated deny emits audit
    it('POST /agents/:id/skills host_docker deny emits audit', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [stoppedAgent] })
        .mockResolvedValueOnce({ rows: [hostDockerSkill] });

      await request(app)
        .post(`/agents/${AGENT_ID}/skills`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ skill_id: SKILL_HOST_DOCKER });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('skill_assign_denied');
      expect(audits[0].skill_scope).toBe('host_docker');
    });

    // T9: Skill assign elevated success emits audit
    it('POST /agents/:id/skills admin assign host_docker emits audit', async () => {
      const adminAssignment = { ...assignmentRecord, skill_id: SKILL_HOST_DOCKER, assigned_by: 'admin-user' };
      mockQuery
        .mockResolvedValueOnce({ rows: [stoppedAgent] })
        .mockResolvedValueOnce({ rows: [hostDockerSkill] })
        .mockResolvedValueOnce({ rows: [adminAssignment] })
        .mockResolvedValueOnce({ rows: [{ tools_config: devToolsConfig }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .post(`/agents/${AGENT_ID}/skills`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ skill_id: SKILL_HOST_DOCKER });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('skill_assign');
      expect(audits[0].skill_scope).toBe('host_docker');
    });

    // T10: Skill remove elevated deny emits audit
    it('DELETE /agents/:id/skills/:skillId host_docker deny emits audit', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [stoppedAgent] })
        .mockResolvedValueOnce({ rows: [hostDockerSkill] });

      await request(app)
        .delete(`/agents/${AGENT_ID}/skills/${SKILL_HOST_DOCKER}`)
        .set('Authorization', `Bearer ${userToken}`);

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('skill_remove_denied');
      expect(audits[0].skill_scope).toBe('host_docker');
    });

    // T11: Skill remove elevated success emits audit
    it('DELETE /agents/:id/skills/:skillId admin remove host_docker emits audit', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [stoppedAgent] })
        .mockResolvedValueOnce({ rows: [hostDockerSkill] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .delete(`/agents/${AGENT_ID}/skills/${SKILL_HOST_DOCKER}`)
        .set('Authorization', `Bearer ${adminToken}`);

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('skill_remove');
      expect(audits[0].skill_scope).toBe('host_docker');
    });

    // T24: Non-elevated skill assign does NOT emit audit
    it('POST /agents/:id/skills container_local assign does not emit audit', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [stoppedAgent] })
        .mockResolvedValueOnce({ rows: [containerSkill] })
        .mockResolvedValueOnce({ rows: [assignmentRecord] })
        .mockResolvedValueOnce({ rows: [{ tools_config: devToolsConfig }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await request(app)
        .post(`/agents/${AGENT_ID}/skills`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ skill_id: SKILL_CONTAINER });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('skill_assign');
      expect(audits[0].skill_scope).toBe('container_local');
    });
  });
});
