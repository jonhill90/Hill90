import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';

export const AVATAR_BUCKET = 'user-avatars';

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT || 'http://minio:9000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || '',
        secretAccessKey: process.env.MINIO_SECRET_KEY || '',
      },
    });
  }
  return s3Client;
}

export async function ensureBucket(
  client: S3Client,
  bucket: string
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err: any) {
    if (
      err.name === 'NotFound' ||
      err.name === 'NoSuchBucket' ||
      err.$metadata?.httpStatusCode === 404
    ) {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } else {
      throw err;
    }
  }
}
