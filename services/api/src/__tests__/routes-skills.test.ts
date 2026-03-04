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

const developerSkill = {
  id: 'skill-dev',
  name: 'Developer',
  description: 'Full dev environment',
  tools_config: {
    shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: [], max_timeout: 300 },
    filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
    health: { enabled: true },
  },
  is_platform: true,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const minimalSkill = {
  id: 'skill-min',
  name: 'Minimal',
  description: 'Health only',
  tools_config: {
    shell: { enabled: false },
    filesystem: { enabled: false },
    health: { enabled: true },
  },
  is_platform: true,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const adminCreatedSkill = {
  id: 'skill-custom',
  name: 'Custom Admin Skill',
  description: 'Admin-created non-platform skill',
  tools_config: {
    shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: [], max_timeout: 60 },
    filesystem: { enabled: false },
    health: { enabled: true },
  },
  is_platform: false,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// T1: Skill CRUD routes
describe('Skill CRUD routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // T1: List skills returns all with scope
  it('GET /skills returns all skills', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [developerSkill, minimalSkill, adminCreatedSkill],
    });
    const res = await request(app)
      .get('/skills')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('GET /skills user sees all skills', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [developerSkill, minimalSkill],
    });
    const res = await request(app)
      .get('/skills')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const call = mockQuery.mock.calls[0];
    expect(call[0]).not.toMatch(/WHERE.*created_by/);
  });

  it('GET /skills returns 401 without auth', async () => {
    const res = await request(app).get('/skills');
    expect(res.status).toBe(401);
  });

  it('GET /skills returns 403 for no-role user', async () => {
    const noRoleToken = makeToken('no-role', []);
    const res = await request(app)
      .get('/skills')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  // T2: Create skill requires admin
  it('POST /skills rejects non-admin create', async () => {
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'user-skill', tools_config: { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } } });
    expect(res.status).toBe(403);
  });

  it('POST /skills rejects create without name', async () => {
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tools_config: { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('POST /skills rejects create without tools_config', async () => {
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'no-config' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tools_config');
  });

  it('POST /skills admin creates skill', async () => {
    const newSkill = { ...adminCreatedSkill, id: 'new-id' };
    mockQuery.mockResolvedValueOnce({ rows: [newSkill] });
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Custom Admin Skill',
        description: 'Admin-created non-platform skill',
        tools_config: adminCreatedSkill.tools_config,
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Custom Admin Skill');
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO skills');
  });

  it('POST /skills returns 409 on duplicate name', async () => {
    mockQuery.mockRejectedValueOnce({ code: '23505' });
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Developer', tools_config: { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } } });
    expect(res.status).toBe(409);
  });

  it('GET /skills/:id returns skill', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [developerSkill] });
    const res = await request(app)
      .get('/skills/skill-dev')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Developer');
  });

  it('GET /skills/:id returns 404 for unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/skills/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /skills/:id rejects non-admin update', async () => {
    const res = await request(app)
      .put('/skills/skill-custom')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(403);
  });

  it('PUT /skills/:id rejects update of platform skill', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [developerSkill] });
    const res = await request(app)
      .put('/skills/skill-dev')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed Developer' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('platform');
  });

  it('PUT /skills/:id admin updates non-platform skill', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedSkill] })
      .mockResolvedValueOnce({ rows: [{ ...adminCreatedSkill, name: 'Renamed' }] });
    const res = await request(app)
      .put('/skills/skill-custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  it('DELETE /skills/:id rejects non-admin delete', async () => {
    const res = await request(app)
      .delete('/skills/skill-custom')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it('DELETE /skills/:id rejects delete of platform skill', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [developerSkill] });
    const res = await request(app)
      .delete('/skills/skill-dev')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('platform');
  });

  it('DELETE /skills/:id rejects delete of skill assigned to agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedSkill] })
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', agent_slug: 'my-agent' }] });
    const res = await request(app)
      .delete('/skills/skill-custom')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('agents');
  });

  it('DELETE /skills/:id admin deletes unassigned skill', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedSkill] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app)
      .delete('/skills/skill-custom')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('DELETE /skills/:id returns 404 for unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .delete('/skills/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // instructions_md support
  it('GET /skills returns skills with instructions_md field', async () => {
    const skillWithInstructions = {
      ...developerSkill,
      instructions_md: 'You have full developer access with bash, git, make, curl, and jq available.',
    };
    mockQuery.mockResolvedValueOnce({ rows: [skillWithInstructions] });
    const res = await request(app)
      .get('/skills')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body[0].instructions_md).toBe(
      'You have full developer access with bash, git, make, curl, and jq available.'
    );
  });

  it('POST /skills admin creates skill with instructions_md', async () => {
    const created = {
      ...adminCreatedSkill,
      id: 'new-id',
      instructions_md: 'Custom instructions for this skill.',
    };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Custom Skill',
        description: 'A custom skill',
        tools_config: adminCreatedSkill.tools_config,
        instructions_md: 'Custom instructions for this skill.',
      });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('instructions_md');
    expect(insertCall[1]).toContain('Custom instructions for this skill.');
  });

  it('PUT /skills/:id admin updates skill instructions_md', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedSkill] })
      .mockResolvedValueOnce({
        rows: [{ ...adminCreatedSkill, instructions_md: 'Updated instructions.' }],
      });
    const res = await request(app)
      .put('/skills/skill-custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ instructions_md: 'Updated instructions.' });
    expect(res.status).toBe(200);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('instructions_md');
  });

  // scope support
  it('GET /skills includes scope in response', async () => {
    const skillWithScope = { ...developerSkill, scope: 'container_local' };
    mockQuery.mockResolvedValueOnce({ rows: [skillWithScope] });
    const res = await request(app)
      .get('/skills')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body[0].scope).toBe('container_local');
    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain('scope');
  });

  it('POST /skills admin creates skill with scope', async () => {
    const created = { ...adminCreatedSkill, id: 'new-id', scope: 'host_docker' };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Docker Operator',
        description: 'Host docker access',
        tools_config: adminCreatedSkill.tools_config,
        scope: 'host_docker',
      });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('scope');
    expect(insertCall[1]).toContain('host_docker');
  });

  it('POST /skills rejects invalid scope', async () => {
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Bad Scope',
        tools_config: adminCreatedSkill.tools_config,
        scope: 'invalid_scope',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scope');
  });

  it('PUT /skills/:id rejects invalid scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [adminCreatedSkill] });
    const res = await request(app)
      .put('/skills/skill-custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scope: 'invalid_scope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scope');
  });

  it('POST /skills creates skill with empty instructions_md when omitted', async () => {
    const created = {
      ...adminCreatedSkill,
      id: 'new-id',
      instructions_md: '',
    };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/skills')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'No Instructions Skill',
        tools_config: adminCreatedSkill.tools_config,
      });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1]).toContain('');
  });

  // T3: /tool-presets compat alias serves same data as /skills
  it('GET /tool-presets compat alias returns same data as /skills', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [developerSkill, minimalSkill],
    });
    const res = await request(app)
      .get('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('Developer');
  });

  it('POST /tool-presets compat alias creates skill', async () => {
    const newSkill = { ...adminCreatedSkill, id: 'new-id' };
    mockQuery.mockResolvedValueOnce({ rows: [newSkill] });
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Custom Admin Skill',
        description: 'Admin-created non-platform skill',
        tools_config: adminCreatedSkill.tools_config,
      });
    expect(res.status).toBe(201);
    // Verify query hits the skills table (not tool_presets)
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO skills');
  });

  // kind and tool_dependencies
  describe('kind and tool_dependencies', () => {
    // T1: GET /skills returns kind and tool_dependencies
    it('GET /skills returns kind and tool_dependencies', async () => {
      const skillWithKind = { ...developerSkill, kind: 'profile', tool_dependencies: [] };
      const skillWithDeps = { ...adminCreatedSkill, kind: 'skill', tool_dependencies: ['gh', 'git'] };
      mockQuery.mockResolvedValueOnce({ rows: [skillWithKind, skillWithDeps] });
      const res = await request(app)
        .get('/skills')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body[0].kind).toBe('profile');
      expect(res.body[0].tool_dependencies).toEqual([]);
      expect(res.body[1].kind).toBe('skill');
      expect(res.body[1].tool_dependencies).toEqual(['gh', 'git']);
    });

    // T2: GET /skills?kind=profile returns only profiles
    it('GET /skills?kind=profile returns only profiles', async () => {
      const profileSkill = { ...developerSkill, kind: 'profile', tool_dependencies: [] };
      mockQuery.mockResolvedValueOnce({ rows: [profileSkill] });
      const res = await request(app)
        .get('/skills?kind=profile')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].kind).toBe('profile');
      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0]).toContain('WHERE kind = $1');
      expect(selectCall[1]).toContain('profile');
    });

    // T3: GET /skills?kind=skill returns only skills
    it('GET /skills?kind=skill returns only skills', async () => {
      const skillOnly = { ...adminCreatedSkill, kind: 'skill', tool_dependencies: [] };
      mockQuery.mockResolvedValueOnce({ rows: [skillOnly] });
      const res = await request(app)
        .get('/skills?kind=skill')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].kind).toBe('skill');
      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0]).toContain('WHERE kind = $1');
      expect(selectCall[1]).toContain('skill');
    });

    // T4: POST /skills defaults kind to 'skill'
    it('POST /skills defaults kind to skill', async () => {
      const created = { ...adminCreatedSkill, id: 'new-id', kind: 'skill', tool_dependencies: [] };
      mockQuery.mockResolvedValueOnce({ rows: [created] });
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Default Kind Skill',
          tools_config: adminCreatedSkill.tools_config,
        });
      expect(res.status).toBe(201);
      const insertCall = mockQuery.mock.calls[0];
      expect(insertCall[0]).toContain('INSERT INTO skills');
      expect(insertCall[1]).toContain('skill');
    });

    // T5: POST /skills creates profile with kind=profile
    it('POST /skills creates profile with kind=profile', async () => {
      const created = { ...adminCreatedSkill, id: 'new-id', kind: 'profile', tool_dependencies: [] };
      mockQuery.mockResolvedValueOnce({ rows: [created] });
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'My Profile',
          tools_config: adminCreatedSkill.tools_config,
          kind: 'profile',
        });
      expect(res.status).toBe(201);
      const insertCall = mockQuery.mock.calls[0];
      expect(insertCall[1]).toContain('profile');
    });

    // T6: POST /skills creates skill with tool_dependencies
    it('POST /skills creates skill with tool_dependencies', async () => {
      const created = { ...adminCreatedSkill, id: 'new-id', kind: 'skill', tool_dependencies: ['gh', 'git'] };
      mockQuery.mockResolvedValueOnce({ rows: [created] });
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Deps Skill',
          tools_config: adminCreatedSkill.tools_config,
          tool_dependencies: ['gh', 'git'],
        });
      expect(res.status).toBe(201);
      const insertCall = mockQuery.mock.calls[0];
      expect(insertCall[0]).toContain('tool_dependencies');
      expect(insertCall[1]).toContain(JSON.stringify(['gh', 'git']));
    });

    // T7: POST /skills defaults tool_dependencies to []
    it('POST /skills defaults tool_dependencies to empty array', async () => {
      const created = { ...adminCreatedSkill, id: 'new-id', kind: 'skill', tool_dependencies: [] };
      mockQuery.mockResolvedValueOnce({ rows: [created] });
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'No Deps Skill',
          tools_config: adminCreatedSkill.tools_config,
        });
      expect(res.status).toBe(201);
      const insertCall = mockQuery.mock.calls[0];
      expect(insertCall[1]).toContain('[]');
    });

    // T8: POST /skills rejects profile with non-empty tool_dependencies
    it('POST /skills rejects profile with non-empty tool_dependencies', async () => {
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Bad Profile',
          tools_config: adminCreatedSkill.tools_config,
          kind: 'profile',
          tool_dependencies: ['gh'],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Profiles cannot have tool_dependencies');
    });

    // T9: POST /skills rejects invalid kind
    it('POST /skills rejects invalid kind', async () => {
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Bad Kind',
          tools_config: adminCreatedSkill.tools_config,
          kind: 'banana',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('kind');
    });

    // T10: POST /skills rejects non-array tool_dependencies
    it('POST /skills rejects non-array tool_dependencies', async () => {
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Bad Deps',
          tools_config: adminCreatedSkill.tools_config,
          tool_dependencies: 'not-an-array',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tool_dependencies');
    });

    // T11: POST /skills rejects non-string array entries
    it('POST /skills rejects non-string array entries in tool_dependencies', async () => {
      const res = await request(app)
        .post('/skills')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Bad Entries',
          tools_config: adminCreatedSkill.tools_config,
          tool_dependencies: [123],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tool_dependencies');
    });

    // T12: PUT /skills/:id updates kind and tool_dependencies
    it('PUT /skills/:id updates kind and tool_dependencies', async () => {
      const existingSkill = { ...adminCreatedSkill, kind: 'skill', tool_dependencies: [] };
      const updatedSkill = { ...adminCreatedSkill, kind: 'skill', tool_dependencies: ['gh', 'git'] };
      mockQuery
        .mockResolvedValueOnce({ rows: [existingSkill] })
        .mockResolvedValueOnce({ rows: [updatedSkill] });
      const res = await request(app)
        .put('/skills/skill-custom')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ kind: 'skill', tool_dependencies: ['gh', 'git'] });
      expect(res.status).toBe(200);
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('kind');
      expect(updateCall[0]).toContain('tool_dependencies');
    });
  });
});
