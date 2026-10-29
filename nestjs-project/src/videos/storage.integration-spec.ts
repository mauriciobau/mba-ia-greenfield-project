import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { S3StorageService } from './s3-storage.service';

describe('S3 multipart storage (integration)', () => {
  let client: S3Client;
  let storage: S3StorageService;

  beforeAll(() => {
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? 'streamtube',
        secretAccessKey:
          process.env.S3_SECRET_KEY ?? 'streamtube-local-password',
      },
    });
    const config = {
      getOrThrow: (key: string) =>
        key === 'S3_BUCKET' ? (process.env.S3_BUCKET ?? 'videos') : undefined,
    } as ConfigService;
    storage = new S3StorageService(client, config);
  });

  afterAll(() => {
    client.destroy();
  });

  it('starts and aborts a real multipart upload in MinIO', async () => {
    const key = `integration-tests/${randomUUID()}/source`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    expect(uploadId).toEqual(expect.any(String));
    await storage.abortMultipartUpload(key, uploadId);
    await expect(
      storage.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  }, 30000);
});
