import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/role';
import { getPool } from '../db/pool';
import { getS3Client } from '../services/s3';
import {
  processAvatar,
  avatarKey,
  uploadAvatar,
  deleteAvatar,
  getAvatarStream,
} from '../services/avatar';
import {
  getKeycloakProfile,
  updateKeycloakProfile,
} from '../services/keycloak-account';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function getIssuer(): string {
  return process.env.KEYCLOAK_ISSUER || 'https://auth.hill90.com/realms/hill90';
}

function getBearerToken(req: Request): string {
  return req.headers.authorization!.slice(7);
}

// GET /profile — fetch Keycloak profile + DB avatar key
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const token = getBearerToken(req);

    const [kcProfile, dbResult] = await Promise.all([
      getKeycloakProfile(getIssuer(), token),
      getPool().query(
        'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
        [user.sub]
      ),
    ]);

    res.json({
      username: kcProfile.username,
      firstName: kcProfile.firstName,
      lastName: kcProfile.lastName,
      email: kcProfile.email,
      emailVerified: kcProfile.emailVerified,
      hasAvatar: !!(dbResult.rows[0]?.avatar_key),
    });
  } catch (err) {
    console.error('[profile] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /profile — update display name via Keycloak Account API
router.patch('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { firstName, lastName } = req.body;

    if (firstName !== undefined && (typeof firstName !== 'string' || firstName.length > 100)) {
      res.status(400).json({ error: 'firstName must be a string of max 100 characters' });
      return;
    }
    if (lastName !== undefined && (typeof lastName !== 'string' || lastName.length > 100)) {
      res.status(400).json({ error: 'lastName must be a string of max 100 characters' });
      return;
    }
    if (firstName === undefined && lastName === undefined) {
      res.status(400).json({ error: 'At least one of firstName or lastName is required' });
      return;
    }

    const token = getBearerToken(req);
    const updates: { firstName?: string; lastName?: string } = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;

    const updated = await updateKeycloakProfile(getIssuer(), token, updates);
    res.json({
      firstName: updated.firstName,
      lastName: updated.lastName,
    });
  } catch (err) {
    console.error('[profile] PATCH error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /profile/avatar — upload avatar
router.post('/avatar', requireRole('user'), upload.single('avatar'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP' });
      return;
    }

    const processed = await processAvatar(file.buffer);
    const key = avatarKey(user.sub);
    const s3 = getS3Client();

    // Check for existing avatar to delete old S3 object
    const { rows } = await getPool().query(
      'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
      [user.sub]
    );
    const oldKey = rows[0]?.avatar_key;

    await uploadAvatar(s3, key, processed);

    // Upsert profile row
    await getPool().query(
      `INSERT INTO user_profiles (keycloak_id, avatar_key)
       VALUES ($1, $2)
       ON CONFLICT (keycloak_id) DO UPDATE SET avatar_key = $2, updated_at = NOW()`,
      [user.sub, key]
    );

    // Delete old S3 object after successful upsert
    if (oldKey) {
      try {
        await deleteAvatar(s3, oldKey);
      } catch (err) {
        console.error('[profile] Failed to delete old avatar:', err);
      }
    }

    res.json({ message: 'Avatar uploaded' });
  } catch (err) {
    console.error('[profile] POST avatar error:', err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// DELETE /profile/avatar — delete avatar
router.delete('/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query(
      'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
      [user.sub]
    );

    if (!rows[0]?.avatar_key) {
      res.status(404).json({ error: 'No avatar found' });
      return;
    }

    const s3 = getS3Client();
    await deleteAvatar(s3, rows[0].avatar_key);

    await getPool().query(
      'UPDATE user_profiles SET avatar_key = NULL, updated_at = NOW() WHERE keycloak_id = $1',
      [user.sub]
    );

    res.json({ message: 'Avatar deleted' });
  } catch (err) {
    console.error('[profile] DELETE avatar error:', err);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

// GET /profile/avatar — stream avatar from S3
router.get('/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query(
      'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
      [user.sub]
    );

    if (!rows[0]?.avatar_key) {
      res.status(404).json({ error: 'No avatar found' });
      return;
    }

    const s3 = getS3Client();
    const { stream, etag } = await getAvatarStream(s3, rows[0].avatar_key);

    // Support conditional requests
    if (etag && req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-cache');
    if (etag) res.setHeader('ETag', etag);

    (stream as any).pipe(res);
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: 'No avatar found' });
      return;
    }
    console.error('[profile] GET avatar error:', err);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// POST /profile/password — change password
// NOTE: Keycloak 12+ removed the /account/credentials/password REST endpoint.
// Password changes now require a browser redirect via kc_action=UPDATE_PASSWORD.
// This endpoint returns a structured 501 until a browser-based flow is implemented in the UI.
router.post('/password', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({
    error: 'Password change not yet available',
    code: 'NOT_IMPLEMENTED',
  });
});

export default router;
