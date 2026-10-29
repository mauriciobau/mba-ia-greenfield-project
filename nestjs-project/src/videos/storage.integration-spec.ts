import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { S3StorageService } from './s3-storage.service';

describe('S3 multipart storage (integration)', () => {
  let client: S3Client;
  let publicClient: S3Client;
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
    publicClient = new S3Client({
      endpoint: process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
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
    storage = new S3StorageService(client, publicClient, config);
  });

  afterAll(() => {
    client.destroy();
    publicClient.destroy();
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

  it('lists real uploaded parts and signs them against the public endpoint', async () => {
    const key = `integration-tests/${randomUUID()}/parts`;
    const started = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Key: key,
        ContentType: 'video/mp4',
      }),
    );
    if (!started.UploadId) throw new Error('MinIO returned no upload id');

    try {
      const body = Buffer.alloc(5 * 1024 * 1024, 1);
      const uploaded = await client.send(
        new UploadPartCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Key: key,
          UploadId: started.UploadId,
          PartNumber: 1,
          Body: body,
        }),
      );
      const page = await storage.listParts(key, started.UploadId);
      const signedUrl = await storage.createPartUrl(key, started.UploadId, 2);
      const parsedUrl = new URL(signedUrl);

      expect(page.parts).toEqual([
        { partNumber: 1, size: body.byteLength, etag: uploaded.ETag },
      ]);
      expect(page.nextCursor).toBeNull();
      expect(parsedUrl.origin).toBe(
        process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
      );
      expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe('300');

      const secondPage = await client.send(
        new ListPartsCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Key: key,
          UploadId: started.UploadId,
          PartNumberMarker: '1',
          MaxParts: 1000,
        }),
      );
      expect(secondPage.Parts ?? []).toHaveLength(0);
      const cursorPage = await storage.listParts(key, started.UploadId, 1);
      expect(cursorPage.parts).toHaveLength(0);
    } finally {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Key: key,
          UploadId: started.UploadId,
        }),
      );
    }
  }, 30000);
});
