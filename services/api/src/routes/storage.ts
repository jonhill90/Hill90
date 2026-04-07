import { Router, Request, Response } from 'express';
import {
  ListBucketsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getS3Client } from '../services/s3';
import { requireRole } from '../middleware/role';

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

export default router;
