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
const adminToken = makeToken('admin-user', ['admin', 'user']);

const PROFILE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const standardProfile = {
  id: 'profile-uuid-1',
  name: 'standard',
  description: 'Standard agentbox runtime',
  docker_image: 'hill90/agentbox:latest',
  default_cpus: '1.0',
  default_mem_limit: '1g',
  default_pids_limit: 200,
  is_platform: true,
  metadata: {},
  created_at: '2026-03-14T00:00:00Z',
  updated_at: '2026-03-14T00:00:00Z',
};

const customProfile = {
  id: PROFILE_UUID,
  name: 'gpu-enabled',
  description: 'GPU-enabled runtime',
  docker_image: 'hill90/agentbox-gpu:latest',
  default_cpus: '2.0',
  default_mem_limit: '4g',
  default_pids_limit: 400,
  is_platform: false,
  metadata: {},
  created_at: '2026-03-14T00:00:00Z',
  updated_at: '2026-03-14T00:00:00Z',
};

const browserProfile = {
  id: 'profile-uuid-browser',
  name: 'browser',
  description: 'Agentbox with Playwright and Chromium',
  docker_image: 'hill90/agentbox-browser:latest',
  default_cpus: '2.0',
  default_mem_limit: '2g',
  default_pids_limit: 300,
  is_platform: true,
  metadata: { extra_env: ['PLAYWRIGHT_BROWSERS_PATH=/data/browsers'], shm_size: '256m' },
  created_at: '2026-04-04T00:00:00Z',
  updated_at: '2026-04-04T00:00:00Z',
};

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

  // ---------------------------------------------------------------------------
  // GET /:id — single profile
  // ---------------------------------------------------------------------------

  // CP-4: GET /container-profiles/:id returns single profile
  it('GET /container-profiles/:id returns single profile (200)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [customProfile] });

    const res = await request(app)
      .get(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PROFILE_UUID);
    expect(res.body.name).toBe('gpu-enabled');
    expect(res.body.docker_image).toBe('hill90/agentbox-gpu:latest');
  });

  // CP-14: GET /container-profiles/:id nonexistent returns 404
  it('GET /container-profiles/:id nonexistent returns 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ---------------------------------------------------------------------------
  // POST / — create profile
  // ---------------------------------------------------------------------------

  // CP-3: POST /container-profiles admin creates profile (201)
  it('POST /container-profiles admin creates profile (201)', async () => {
    const newProfile = { ...customProfile, is_platform: false };
    mockQuery.mockResolvedValueOnce({ rows: [newProfile] });

    const res = await request(app)
      .post('/container-profiles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'gpu-enabled', docker_image: 'hill90/agentbox-gpu:latest', description: 'GPU-enabled runtime' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('gpu-enabled');
    expect(res.body.is_platform).toBe(false);
  });

  // CP-7: POST /container-profiles missing name returns 400
  it('POST /container-profiles missing name returns 400', async () => {
    const res = await request(app)
      .post('/container-profiles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ docker_image: 'hill90/agentbox-gpu:latest' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  // CP-8: POST /container-profiles missing docker_image returns 400
  it('POST /container-profiles missing docker_image returns 400', async () => {
    const res = await request(app)
      .post('/container-profiles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'gpu-enabled' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/docker_image/i);
  });

  // CP-9: POST /container-profiles duplicate name returns 409
  it('POST /container-profiles duplicate name returns 409', async () => {
    const err: any = new Error('duplicate');
    err.code = '23505';
    mockQuery.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/container-profiles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'standard', docker_image: 'hill90/agentbox:latest' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  // CP-15: POST /container-profiles non-admin returns 403
  it('POST /container-profiles non-admin returns 403', async () => {
    const res = await request(app)
      .post('/container-profiles')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'gpu-enabled', docker_image: 'hill90/agentbox-gpu:latest' });

    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // PUT /:id — update profile
  // ---------------------------------------------------------------------------

  // CP-5: PUT /container-profiles/:id admin updates profile (200)
  it('PUT /container-profiles/:id admin updates profile (200)', async () => {
    const updated = { ...customProfile, docker_image: 'hill90/agentbox-gpu:v2' };
    mockQuery
      .mockResolvedValueOnce({ rows: [customProfile] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [updated] }); // UPDATE RETURNING

    const res = await request(app)
      .put(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ docker_image: 'hill90/agentbox-gpu:v2' });

    expect(res.status).toBe(200);
    expect(res.body.docker_image).toBe('hill90/agentbox-gpu:v2');
  });

  // CP-10: PUT /container-profiles/:id nonexistent returns 404
  it('PUT /container-profiles/:id nonexistent returns 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ docker_image: 'hill90/agentbox-gpu:v2' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // CP-16: PUT /container-profiles/:id non-admin returns 403
  it('PUT /container-profiles/:id non-admin returns 403', async () => {
    const res = await request(app)
      .put(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ docker_image: 'hill90/agentbox-gpu:v2' });

    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id — delete profile
  // ---------------------------------------------------------------------------

  // CP-6: DELETE /container-profiles/:id admin deletes unassigned non-platform profile (200)
  it('DELETE /container-profiles/:id admin deletes non-platform unassigned profile (200)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [customProfile] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [] }) // SELECT agents referencing
      .mockResolvedValueOnce({ rows: [] }); // DELETE

    const res = await request(app)
      .delete(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  // CP-11: DELETE /container-profiles/:id platform profile returns 403
  it('DELETE /container-profiles/:id platform profile returns 403', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [standardProfile] }); // SELECT existing (is_platform=true)

    const res = await request(app)
      .delete(`/container-profiles/profile-uuid-1`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/platform profile/i);
  });

  // CP-12: DELETE /container-profiles/:id profile in use by agents returns 409
  it('DELETE /container-profiles/:id profile in use by agents returns 409', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [customProfile] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: 'agent-uuid', agent_id: 'my-agent' }] }); // agents referencing

    const res = await request(app)
      .delete(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/agents are assigned/i);
    expect(res.body.agent_id).toBe('my-agent');
  });

  // CP-13: DELETE /container-profiles/:id nonexistent returns 404
  it('DELETE /container-profiles/:id nonexistent returns 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // CP-17: DELETE /container-profiles/:id non-admin returns 403
  it('DELETE /container-profiles/:id non-admin returns 403', async () => {
    const res = await request(app)
      .delete(`/container-profiles/${PROFILE_UUID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Phase 2: metadata support (T1-T3)
  // ---------------------------------------------------------------------------

  // T1: GET returns metadata field
  it('T1: GET /container-profiles returns metadata field', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [standardProfile, browserProfile] });

    const res = await request(app)
      .get('/container-profiles')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].metadata).toEqual({});
    expect(res.body[1].metadata).toEqual({
      extra_env: ['PLAYWRIGHT_BROWSERS_PATH=/data/browsers'],
      shm_size: '256m',
    });
  });

  // T2: GET single profile returns metadata
  it('T2: GET /container-profiles/:id returns metadata', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [browserProfile] });

    const res = await request(app)
      .get('/container-profiles/profile-uuid-browser')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.metadata.shm_size).toBe('256m');
    expect(res.body.metadata.extra_env).toContain('PLAYWRIGHT_BROWSERS_PATH=/data/browsers');
  });

  // T3: POST accepts metadata
  it('T3: POST /container-profiles accepts metadata', async () => {
    const newProfile = {
      ...customProfile,
      metadata: { extra_env: ['MY_VAR=1'], shm_size: '128m' },
    };
    mockQuery.mockResolvedValueOnce({ rows: [newProfile] });

    const res = await request(app)
      .post('/container-profiles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'custom-profile',
        docker_image: 'hill90/agentbox-custom:latest',
        metadata: { extra_env: ['MY_VAR=1'], shm_size: '128m' },
      });

    expect(res.status).toBe(201);
    // Verify metadata was passed in the INSERT query
    const insertCall = mockQuery.mock.calls[0];
    const sql = insertCall[0] as string;
    expect(sql).toContain('metadata');
    // 7th param is the serialized metadata
    expect(insertCall[1][6]).toContain('MY_VAR=1');
  });

  // T5/T6: Verify createAndStartContainer interface accepts metadata
  // (Integration tested via T4 in routes-agents.test.ts — these verify the API layer passes metadata through)

  // ---------------------------------------------------------------------------
  // Audit emission tests
  // ---------------------------------------------------------------------------

  describe('audit emissions', () => {
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

    // CP-18: POST emits container_profile_create audit
    it('POST /container-profiles emits container_profile_create audit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [customProfile] });

      await request(app)
        .post('/container-profiles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'gpu-enabled', docker_image: 'hill90/agentbox-gpu:latest' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('container_profile_create');
      expect(audits[0].agent_id).toBe(PROFILE_UUID);
      expect(audits[0].principal_type).toBe('human');
      expect(audits[0].profile_name).toBe('gpu-enabled');
    });

    // CP-19: PUT emits container_profile_update audit
    it('PUT /container-profiles/:id emits container_profile_update audit', async () => {
      const updated = { ...customProfile, docker_image: 'hill90/agentbox-gpu:v2' };
      mockQuery
        .mockResolvedValueOnce({ rows: [customProfile] })
        .mockResolvedValueOnce({ rows: [updated] });

      await request(app)
        .put(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ docker_image: 'hill90/agentbox-gpu:v2' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('container_profile_update');
      expect(audits[0].agent_id).toBe(PROFILE_UUID);
      expect(audits[0].principal_type).toBe('human');
      expect(audits[0].profile_name).toBe('gpu-enabled');
    });

    // CP-20: DELETE emits container_profile_delete audit
    it('DELETE /container-profiles/:id emits container_profile_delete audit', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [customProfile] })
        .mockResolvedValueOnce({ rows: [] }) // no agents referencing
        .mockResolvedValueOnce({ rows: [] }); // DELETE

      await request(app)
        .delete(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${adminToken}`);

      const audits = getAuditCalls();
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('container_profile_delete');
      expect(audits[0].agent_id).toBe(PROFILE_UUID);
      expect(audits[0].principal_type).toBe('human');
      expect(audits[0].profile_name).toBe('gpu-enabled');
    });

    // CP-21: DELETE blocked by platform guard does NOT emit audit
    it('DELETE blocked by platform guard does NOT emit audit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [standardProfile] });

      await request(app)
        .delete(`/container-profiles/profile-uuid-1`)
        .set('Authorization', `Bearer ${adminToken}`);

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-22: DELETE blocked by agent reference does NOT emit audit
    it('DELETE blocked by agent reference does NOT emit audit', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [customProfile] })
        .mockResolvedValueOnce({ rows: [{ id: 'agent-uuid', agent_id: 'my-agent' }] });

      await request(app)
        .delete(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${adminToken}`);

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-23: POST duplicate name (409) does NOT emit audit
    it('POST duplicate name (409) does NOT emit audit', async () => {
      const err: any = new Error('duplicate');
      err.code = '23505';
      mockQuery.mockRejectedValueOnce(err);

      await request(app)
        .post('/container-profiles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'standard', docker_image: 'hill90/agentbox:latest' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-24: PUT nonexistent (404) does NOT emit audit
    it('PUT nonexistent (404) does NOT emit audit', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .put(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ docker_image: 'hill90/agentbox-gpu:v2' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-25: PUT duplicate name (409) does NOT emit audit
    it('PUT duplicate name (409) does NOT emit audit', async () => {
      const err: any = new Error('duplicate');
      err.code = '23505';
      mockQuery
        .mockResolvedValueOnce({ rows: [customProfile] }) // SELECT existing
        .mockRejectedValueOnce(err); // UPDATE fails with duplicate

      await request(app)
        .put(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'standard' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-15 audit: POST non-admin does NOT emit audit
    it('POST non-admin does NOT emit audit', async () => {
      await request(app)
        .post('/container-profiles')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'gpu-enabled', docker_image: 'hill90/agentbox-gpu:latest' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-16 audit: PUT non-admin does NOT emit audit
    it('PUT non-admin does NOT emit audit', async () => {
      await request(app)
        .put(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ docker_image: 'hill90/agentbox-gpu:v2' });

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });

    // CP-17 audit: DELETE non-admin does NOT emit audit
    it('DELETE non-admin does NOT emit audit', async () => {
      await request(app)
        .delete(`/container-profiles/${PROFILE_UUID}`)
        .set('Authorization', `Bearer ${userToken}`);

      const audits = getAuditCalls();
      expect(audits).toHaveLength(0);
    });
  });
});
