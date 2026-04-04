import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Mock pg pool
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock docker service (needed because agents.ts is imported transitively)
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
  execInContainer: jest.fn(),
}));

jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

jest.mock('../services/tool-installer', () => ({
  ensureRequiredToolsInstalled: jest.fn(),
  reconcileToolInstalls: jest.fn(),
}));

// Mock shared-knowledge proxy
jest.mock('../services/shared-knowledge-proxy', () => ({
  getStats: jest.fn(),
  listCollections: jest.fn(),
  getCollection: jest.fn(),
  createCollection: jest.fn(),
  updateCollection: jest.fn(),
  deleteCollection: jest.fn(),
  listSources: jest.fn(),
  getSource: jest.fn(),
  createSource: jest.fn(),
  deleteSource: jest.fn(),
  searchShared: jest.fn(),
}));

import * as skProxy from '../services/shared-knowledge-proxy';
const mockGetStats = skProxy.getStats as jest.Mock;
const mockListCollections = skProxy.listCollections as jest.Mock;
const mockGetCollection = skProxy.getCollection as jest.Mock;
const mockCreateCollection = skProxy.createCollection as jest.Mock;
const mockUpdateCollection = skProxy.updateCollection as jest.Mock;
const mockDeleteCollection = skProxy.deleteCollection as jest.Mock;
const mockListSources = skProxy.listSources as jest.Mock;
const mockGetSource = skProxy.getSource as jest.Mock;
const mockCreateSource = skProxy.createSource as jest.Mock;
const mockDeleteSource = skProxy.deleteSource as jest.Mock;
const mockSearchShared = skProxy.searchShared as jest.Mock;

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

describe('Shared Knowledge routes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetStats.mockReset();
    mockListCollections.mockReset();
    mockGetCollection.mockReset();
    mockCreateCollection.mockReset();
    mockUpdateCollection.mockReset();
    mockDeleteCollection.mockReset();
    mockListSources.mockReset();
    mockGetSource.mockReset();
    mockCreateSource.mockReset();
    mockDeleteSource.mockReset();
    mockSearchShared.mockReset();
  });

  // ── Stats ──

  it('GET /shared-knowledge/stats returns stats', async () => {
    mockGetStats.mockResolvedValue({ status: 200, data: { search: {}, ingest: {} } });

    const res = await request(app)
      .get('/shared-knowledge/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ search: {}, ingest: {} });
    expect(mockGetStats).toHaveBeenCalledWith(undefined);
  });

  it('GET /shared-knowledge/stats passes since param', async () => {
    mockGetStats.mockResolvedValue({ status: 200, data: {} });

    await request(app)
      .get('/shared-knowledge/stats?since=24h')
      .set('Authorization', `Bearer ${userToken}`);
    expect(mockGetStats).toHaveBeenCalledWith('24h');
  });

  it('GET /shared-knowledge/stats requires auth', async () => {
    const res = await request(app).get('/shared-knowledge/stats');
    expect(res.status).toBe(401);
  });

  // ── Collections ──

  it('GET /shared-knowledge/collections returns collection list', async () => {
    mockListCollections.mockResolvedValue({
      status: 200,
      data: [{ id: 'col-1', name: 'Test Collection' }],
    });

    const res = await request(app)
      .get('/shared-knowledge/collections')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'col-1', name: 'Test Collection' }]);
    expect(mockListCollections).toHaveBeenCalledWith('regular-user');
  });

  it('POST /shared-knowledge/collections creates collection', async () => {
    mockCreateCollection.mockResolvedValue({
      status: 201,
      data: { id: 'col-new', name: 'New', visibility: 'shared' },
    });

    const res = await request(app)
      .post('/shared-knowledge/collections')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'New', visibility: 'shared' });
    expect(res.status).toBe(201);
    expect(mockCreateCollection).toHaveBeenCalledWith({
      name: 'New',
      description: '',
      visibility: 'shared',
      created_by: 'regular-user',
    });
  });

  it('POST /shared-knowledge/collections requires name (passes through to proxy)', async () => {
    mockCreateCollection.mockResolvedValue({
      status: 400,
      data: { error: 'name is required' },
    });

    const res = await request(app)
      .post('/shared-knowledge/collections')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});
    expect(mockCreateCollection).toHaveBeenCalled();
  });

  it('GET /shared-knowledge/collections/:id returns single collection', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Test', created_by: 'regular-user', visibility: 'private' },
    });

    const res = await request(app)
      .get('/shared-knowledge/collections/col-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('col-1');
  });

  it('GET /shared-knowledge/collections/:id returns 404 for non-owner private collection', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Secret', created_by: 'other-user', visibility: 'private' },
    });

    const res = await request(app)
      .get('/shared-knowledge/collections/col-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /shared-knowledge/collections/:id updates collection', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Old', created_by: 'admin-user', visibility: 'private' },
    });
    mockUpdateCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Updated' },
    });

    const res = await request(app)
      .put('/shared-knowledge/collections/col-1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(mockUpdateCollection).toHaveBeenCalledWith('col-1', {
      name: 'Updated',
      description: undefined,
      visibility: undefined,
    });
  });

  it('PUT /shared-knowledge/collections/:id returns 403 for non-owner', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Other', created_by: 'other-user', visibility: 'private' },
    });

    const res = await request(app)
      .put('/shared-knowledge/collections/col-1')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Hijack' });
    expect(res.status).toBe(403);
  });

  it('DELETE /shared-knowledge/collections/:id deletes collection', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Doomed', created_by: 'admin-user', visibility: 'private' },
    });
    mockDeleteCollection.mockResolvedValue({
      status: 200,
      data: { deleted: true },
    });

    const res = await request(app)
      .delete('/shared-knowledge/collections/col-1')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(mockDeleteCollection).toHaveBeenCalledWith('col-1');
  });

  it('DELETE /shared-knowledge/collections/:id returns 403 for non-owner', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', name: 'Protected', created_by: 'other-user', visibility: 'private' },
    });

    const res = await request(app)
      .delete('/shared-knowledge/collections/col-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  // ── Sources ──

  it('GET /shared-knowledge/sources requires collection_id', async () => {
    const res = await request(app)
      .get('/shared-knowledge/sources')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/collection_id/);
  });

  it('GET /shared-knowledge/sources returns sources for collection', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', created_by: 'regular-user', visibility: 'private' },
    });
    mockListSources.mockResolvedValue({
      status: 200,
      data: [{ id: 'src-1', title: 'Source 1' }],
    });

    const res = await request(app)
      .get('/shared-knowledge/sources?collection_id=col-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'src-1', title: 'Source 1' }]);
    expect(mockListSources).toHaveBeenCalledWith('col-1');
  });

  it('POST /shared-knowledge/sources creates source', async () => {
    mockGetCollection.mockResolvedValue({
      status: 200,
      data: { id: 'col-1', created_by: 'regular-user', visibility: 'private' },
    });
    mockCreateSource.mockResolvedValue({
      status: 201,
      data: { id: 'src-new', title: 'New Source' },
    });

    const res = await request(app)
      .post('/shared-knowledge/sources')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        collection_id: 'col-1',
        title: 'New Source',
        source_type: 'text',
        raw_content: 'Hello world',
      });
    expect(res.status).toBe(201);
    expect(mockCreateSource).toHaveBeenCalledWith({
      collection_id: 'col-1',
      title: 'New Source',
      source_type: 'text',
      raw_content: 'Hello world',
      source_url: undefined,
      created_by: 'regular-user',
    });
  });

  it('DELETE /shared-knowledge/sources/:id deletes source', async () => {
    mockGetSource.mockResolvedValue({
      status: 200,
      data: { id: 'src-1', created_by: 'regular-user', collection_id: 'col-1' },
    });
    mockDeleteSource.mockResolvedValue({
      status: 200,
      data: { deleted: true },
    });

    const res = await request(app)
      .delete('/shared-knowledge/sources/src-1')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(mockDeleteSource).toHaveBeenCalledWith('src-1');
  });

  // ── Search ──

  it('GET /shared-knowledge/search requires q param', async () => {
    const res = await request(app)
      .get('/shared-knowledge/search')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/q/);
  });

  it('GET /shared-knowledge/search returns results', async () => {
    mockSearchShared.mockResolvedValue({
      status: 200,
      data: { results: [{ id: 'chunk-1', snippet: 'match' }] },
    });

    const res = await request(app)
      .get('/shared-knowledge/search?q=test+query')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(mockSearchShared).toHaveBeenCalledWith({
      q: 'test query',
      collection_id: undefined,
      owner: 'regular-user',
      requester_id: 'regular-user',
      requester_type: 'user',
      limit: undefined,
    });
  });
});
