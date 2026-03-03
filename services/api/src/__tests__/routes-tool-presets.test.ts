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

const developerPreset = {
  id: 'preset-dev',
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

const minimalPreset = {
  id: 'preset-min',
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

const adminCreatedPreset = {
  id: 'preset-custom',
  name: 'Custom Admin Preset',
  description: 'Admin-created non-platform preset',
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

describe('Tool Preset CRUD routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  // T1: List presets returns platform seeds
  it('GET /tool-presets returns all presets', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [developerPreset, minimalPreset, adminCreatedPreset],
    });
    const res = await request(app)
      .get('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  // T1 continued: user also sees all presets (no ownership scoping in Phase 1)
  it('GET /tool-presets user sees all presets', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [developerPreset, minimalPreset],
    });
    const res = await request(app)
      .get('/tool-presets')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Verify no ownership scoping (no WHERE ... created_by = filter)
    const call = mockQuery.mock.calls[0];
    expect(call[0]).not.toMatch(/WHERE.*created_by/);
  });

  // T2: List presets requires auth
  it('GET /tool-presets returns 401 without auth', async () => {
    const res = await request(app).get('/tool-presets');
    expect(res.status).toBe(401);
  });

  it('GET /tool-presets returns 403 for no-role user', async () => {
    const noRoleToken = makeToken('no-role', []);
    const res = await request(app)
      .get('/tool-presets')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });

  // T3: Create preset requires admin
  it('POST /tool-presets rejects non-admin create', async () => {
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'user-preset', tools_config: { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } } });
    expect(res.status).toBe(403);
  });

  // T4: Create preset validates name required
  it('POST /tool-presets rejects create without name', async () => {
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tools_config: { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  // T5: Create preset validates tools_config required
  it('POST /tool-presets rejects create without tools_config', async () => {
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'no-config' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tools_config');
  });

  // T6: Create preset succeeds for admin
  it('POST /tool-presets admin creates preset', async () => {
    const newPreset = { ...adminCreatedPreset, id: 'new-id' };
    mockQuery.mockResolvedValueOnce({ rows: [newPreset] });
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Custom Admin Preset',
        description: 'Admin-created non-platform preset',
        tools_config: adminCreatedPreset.tools_config,
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Custom Admin Preset');
    // Admin presets get created_by = null, is_platform = false
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO tool_presets');
  });

  it('POST /tool-presets returns 409 on duplicate name', async () => {
    mockQuery.mockRejectedValueOnce({ code: '23505' });
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Developer', tools_config: { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } } });
    expect(res.status).toBe(409);
  });

  // Get single
  it('GET /tool-presets/:id returns preset', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [developerPreset] });
    const res = await request(app)
      .get('/tool-presets/preset-dev')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Developer');
  });

  it('GET /tool-presets/:id returns 404 for unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/tool-presets/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // T7: Update preset requires admin
  it('PUT /tool-presets/:id rejects non-admin update', async () => {
    const res = await request(app)
      .put('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(403);
  });

  // T8: Update platform preset blocked
  it('PUT /tool-presets/:id rejects update of platform preset', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [developerPreset] }); // existence check returns is_platform = true
    const res = await request(app)
      .put('/tool-presets/preset-dev')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed Developer' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('platform');
  });

  // Update non-platform preset succeeds
  it('PUT /tool-presets/:id admin updates non-platform preset', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedPreset] }) // existence check, is_platform = false
      .mockResolvedValueOnce({ rows: [{ ...adminCreatedPreset, name: 'Renamed' }] }); // update
    const res = await request(app)
      .put('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  // T9: Delete preset requires admin
  it('DELETE /tool-presets/:id rejects non-admin delete', async () => {
    const res = await request(app)
      .delete('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  // T10: Delete platform preset blocked
  it('DELETE /tool-presets/:id rejects delete of platform preset', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [developerPreset] }); // existence check returns is_platform = true
    const res = await request(app)
      .delete('/tool-presets/preset-dev')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('platform');
  });

  // T11: Delete assigned preset blocked
  it('DELETE /tool-presets/:id rejects delete of preset assigned to agent', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedPreset] }) // existence check, is_platform = false
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', agent_id: 'my-agent' }] }); // agents using this preset
    const res = await request(app)
      .delete('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('agents');
  });

  // T12: Delete unassigned preset succeeds
  it('DELETE /tool-presets/:id admin deletes unassigned preset', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedPreset] }) // existence check, is_platform = false
      .mockResolvedValueOnce({ rows: [] }) // no agents assigned
      .mockResolvedValueOnce({ rowCount: 1 }); // delete succeeds
    const res = await request(app)
      .delete('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('DELETE /tool-presets/:id returns 404 for unknown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // existence check returns nothing
    const res = await request(app)
      .delete('/tool-presets/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  // T1: List skills returns instructions_md
  it('GET /tool-presets returns skills with instructions_md field', async () => {
    const presetWithInstructions = {
      ...developerPreset,
      instructions_md: 'You have full developer access with bash, git, make, curl, and jq available.',
    };
    mockQuery.mockResolvedValueOnce({
      rows: [presetWithInstructions],
    });
    const res = await request(app)
      .get('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body[0].instructions_md).toBe(
      'You have full developer access with bash, git, make, curl, and jq available.'
    );
  });

  // T2: Create skill with instructions_md
  it('POST /tool-presets admin creates skill with instructions_md', async () => {
    const created = {
      ...adminCreatedPreset,
      id: 'new-id',
      instructions_md: 'Custom instructions for this skill.',
    };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Custom Skill',
        description: 'A custom skill',
        tools_config: adminCreatedPreset.tools_config,
        instructions_md: 'Custom instructions for this skill.',
      });
    expect(res.status).toBe(201);
    // Verify instructions_md was included in the INSERT
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('instructions_md');
    expect(insertCall[1]).toContain('Custom instructions for this skill.');
  });

  // T3: Update skill instructions_md
  it('PUT /tool-presets/:id admin updates skill instructions_md', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [adminCreatedPreset] }) // existence check
      .mockResolvedValueOnce({
        rows: [{ ...adminCreatedPreset, instructions_md: 'Updated instructions.' }],
      }); // update
    const res = await request(app)
      .put('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ instructions_md: 'Updated instructions.' });
    expect(res.status).toBe(200);
    // Verify instructions_md was included in the UPDATE
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('instructions_md');
  });

  // T11: GET /tool-presets includes scope field
  it('GET /tool-presets includes scope in response', async () => {
    const presetWithScope = { ...developerPreset, scope: 'container_local' };
    mockQuery.mockResolvedValueOnce({ rows: [presetWithScope] });
    const res = await request(app)
      .get('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body[0].scope).toBe('container_local');
    // Verify scope is in the SELECT query
    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain('scope');
  });

  // T12: POST /tool-presets accepts scope
  it('POST /tool-presets admin creates preset with scope', async () => {
    const created = { ...adminCreatedPreset, id: 'new-id', scope: 'host_docker' };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Docker Operator',
        description: 'Host docker access',
        tools_config: adminCreatedPreset.tools_config,
        scope: 'host_docker',
      });
    expect(res.status).toBe(201);
    // Verify scope was included in the INSERT
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('scope');
    expect(insertCall[1]).toContain('host_docker');
  });

  // T13: Invalid scope rejected
  it('POST /tool-presets rejects invalid scope', async () => {
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Bad Scope',
        tools_config: adminCreatedPreset.tools_config,
        scope: 'invalid_scope',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scope');
  });

  // T13 continued: PUT rejects invalid scope
  it('PUT /tool-presets/:id rejects invalid scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [adminCreatedPreset] }); // existence check
    const res = await request(app)
      .put('/tool-presets/preset-custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scope: 'invalid_scope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('scope');
  });

  // T4: Create skill without instructions_md defaults empty
  it('POST /tool-presets creates skill with empty instructions_md when omitted', async () => {
    const created = {
      ...adminCreatedPreset,
      id: 'new-id',
      instructions_md: '',
    };
    mockQuery.mockResolvedValueOnce({ rows: [created] });
    const res = await request(app)
      .post('/tool-presets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'No Instructions Skill',
        tools_config: adminCreatedPreset.tools_config,
      });
    expect(res.status).toBe(201);
    // Verify empty string was passed for instructions_md
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1]).toContain('');
  });
});
