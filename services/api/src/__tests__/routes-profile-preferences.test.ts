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

jest.mock('../services/s3', () => ({
  getS3Client: jest.fn(),
}));

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, realm_roles: roles },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const userToken = makeToken('user-1', ['user']);

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

describe('Profile Preferences', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('GET /profile/preferences returns defaults when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/profile/preferences')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      theme: 'dark',
      notifications_enabled: true,
      sidebar_collapsed: false,
    });
  });

  it('GET /profile/preferences returns stored preferences', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ preferences: { theme: 'dark', notifications_enabled: false, sidebar_collapsed: true } }],
    });

    const res = await request(app)
      .get('/profile/preferences')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.notifications_enabled).toBe(false);
    expect(res.body.sidebar_collapsed).toBe(true);
  });

  it('PUT /profile/preferences upserts with shallow merge', async () => {
    // First query: SELECT existing
    mockQuery.mockResolvedValueOnce({
      rows: [{ preferences: { theme: 'dark', notifications_enabled: true, sidebar_collapsed: false } }],
    });
    // Second query: INSERT ON CONFLICT
    mockQuery.mockResolvedValueOnce({
      rows: [{ preferences: { theme: 'dark', notifications_enabled: false, sidebar_collapsed: false } }],
    });

    const res = await request(app)
      .put('/profile/preferences')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ notifications_enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.notifications_enabled).toBe(false);
    // Unchanged keys preserved
    expect(res.body.theme).toBe('dark');

    // Verify the merged object was written
    const upsertCall = mockQuery.mock.calls[1];
    expect(upsertCall[0]).toContain('ON CONFLICT');
    const written = JSON.parse(upsertCall[1][1]);
    expect(written.notifications_enabled).toBe(false);
    expect(written.theme).toBe('dark');
    expect(written.sidebar_collapsed).toBe(false);
  });

  it('PUT /profile/preferences merges with defaults when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no existing row
    mockQuery.mockResolvedValueOnce({
      rows: [{ preferences: { theme: 'light', notifications_enabled: true, sidebar_collapsed: false } }],
    });

    const res = await request(app)
      .put('/profile/preferences')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ theme: 'light' });

    expect(res.status).toBe(200);
    const written = JSON.parse(mockQuery.mock.calls[1][1][1]);
    expect(written.theme).toBe('light');
    expect(written.notifications_enabled).toBe(true); // from defaults
  });

  it('PUT /profile/preferences rejects array body', async () => {
    const res = await request(app)
      .put('/profile/preferences')
      .set('Authorization', `Bearer ${userToken}`)
      .send([1, 2, 3]);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('JSON object');
  });
});
