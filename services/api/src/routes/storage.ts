import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getS3Client } from '../services/s3';
import { requireRole } from '../middleware/role';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// All storage routes require admin role
router.use(requireRole('admin'));

// GET /storage/buckets — list all MinIO buckets
router.get('/buckets', async (_req: Request, res: Response) => {
  try {
    const s3 = getS3Client();
    const result = await s3.send(new ListBucketsCommand({}));

    const buckets = (result.Buckets || []).map((b) => ({
      name: b.Name,
      created_at: b.CreationDate?.toISOString() || null,
    }));

    res.json(buckets);
  } catch (err: any) {
    console.error('[storage] Failed to list buckets:', err);
    res.status(502).json({ error: 'Failed to connect to storage service' });
  }
});

// GET /storage/buckets/:name/objects — list objects in a bucket
router.get('/buckets/:name/objects', async (req: Request, res: Response) => {
  const { name } = req.params;
  const prefix = (req.query.prefix as string) || '';
  const maxKeys = Math.min(parseInt(req.query.max_keys as string) || 100, 1000);
  const continuationToken = (req.query.continuation_token as string) || undefined;

  try {
    const s3 = getS3Client();
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: name,
      Prefix: prefix || undefined,
      Delimiter: '/',
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken,
    }));

    const objects = (result.Contents || []).map((obj) => ({
      key: obj.Key,
      size: obj.Size,
      last_modified: obj.LastModified?.toISOString() || null,
      etag: obj.ETag,
    }));

    const prefixes = (result.CommonPrefixes || []).map((p) => p.Prefix);

    res.json({
      objects,
      prefixes,
      is_truncated: result.IsTruncated || false,
      next_continuation_token: result.NextContinuationToken || null,
      key_count: result.KeyCount || 0,
    });
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: `Bucket '${name}' not found` });
      return;
    }
    console.error(`[storage] Failed to list objects in ${name}:`, err);
    res.status(502).json({ error: 'Failed to list objects from storage service' });
  }
});

// POST /storage/buckets/:name/upload — upload a file
router.post('/buckets/:name/upload', upload.single('file'), async (req: Request, res: Response) => {
  const { name } = req.params;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const key = (req.body.key as string) || file.originalname;

  try {
    const s3 = getS3Client();
    await s3.send(new PutObjectCommand({
      Bucket: name,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    res.json({ key, size: file.size, content_type: file.mimetype });
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: `Bucket '${name}' not found` });
      return;
    }
    console.error(`[storage] Failed to upload to ${name}:`, err);
    res.status(502).json({ error: 'Failed to upload to storage service' });
  }
});

// DELETE /storage/buckets/:name/objects/* — delete an object
router.delete('/buckets/:name/objects/*', async (req: Request, res: Response) => {
  const { name } = req.params;
  const key = req.params[0];
  if (!key) {
    res.status(400).json({ error: 'No object key provided' });
    return;
  }

  try {
    const s3 = getS3Client();
    await s3.send(new DeleteObjectCommand({
      Bucket: name,
      Key: key,
    }));

    res.json({ deleted: key });
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: `Bucket '${name}' not found` });
      return;
    }
    console.error(`[storage] Failed to delete from ${name}:`, err);
    res.status(502).json({ error: 'Failed to delete from storage service' });
  }
});

export default router;
