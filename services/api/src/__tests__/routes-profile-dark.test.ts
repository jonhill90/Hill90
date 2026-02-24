import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

// Generate a throwaway RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Mock pg pool
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: jest.fn() }),
}));

// Mock docker service
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));

// Mock agent-files service
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

// Mock S3 (profile routes import s3)
jest.mock('../services/s3', () => ({
  getS3Client: jest.fn().mockReturnValue({}),
  AVATAR_BUCKET: 'user-avatars',
  ensureBucket: jest.fn(),
}));

// Mock avatar service
jest.mock('../services/avatar', () => ({
  processAvatar: jest.fn(),
  avatarKey: jest.fn(),
  uploadAvatar: jest.fn(),
  deleteAvatar: jest.fn(),
  getAvatarStream: jest.fn(),
}));

// Mock keycloak-account service
jest.mock('../services/keycloak-account', () => ({
  getKeycloakProfile: jest.fn(),
  updateKeycloakProfile: jest.fn(),
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

describe('Profile routes (mounted — requires auth)', () => {
  it('GET /profile returns 401 without auth (route is mounted)', async () => {
    const res = await request(app).get('/profile');
    expect(res.status).toBe(401);
  });

  it('GET /profile returns 403 without user role (route is mounted)', async () => {
    const token = makeToken('test-user', []);
    const res = await request(app)
      .get('/profile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
