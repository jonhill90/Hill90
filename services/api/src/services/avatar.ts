import sharp from 'sharp';
import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { AVATAR_BUCKET } from './s3';

export async function processAvatar(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(256, 256, { fit: 'cover' })
    .rotate() // auto-rotate based on EXIF, then strip
    .webp({ quality: 80 })
    .toBuffer();
}

export function avatarKey(keycloakId: string): string {
  return `avatars/${keycloakId}/${randomUUID()}.webp`;
}

export function agentAvatarKey(agentId: string): string {
  return `agent-avatars/${agentId}/${randomUUID()}.webp`;
}

export async function uploadAvatar(
  client: S3Client,
  key: string,
  data: Buffer,
  bucket: string = AVATAR_BUCKET
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: 'image/webp',
    })
  );
}

export async function deleteAvatar(
  client: S3Client,
  key: string,
  bucket: string = AVATAR_BUCKET
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

export async function getAvatarStream(
  client: S3Client,
  key: string,
  bucket: string = AVATAR_BUCKET
): Promise<{ stream: NodeJS.ReadableStream; etag?: string }> {
  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
  return {
    stream: res.Body as NodeJS.ReadableStream,
    etag: res.ETag,
  };
}
