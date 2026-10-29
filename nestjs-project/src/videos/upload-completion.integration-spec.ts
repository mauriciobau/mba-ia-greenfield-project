import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingOutbox } from './entities/video-processing-outbox.entity';
import { VideoUpload } from './entities/video-upload.entity';
import { UploadCompletionService } from './upload-completion.service';
import { S3StorageService } from './s3-storage.service';
import { VideosPersistenceService } from './videos.persistence.service';
import { VideoUploadReconciliationService } from './video-upload-reconciliation.service';
import { VIDEO_UPLOAD } from './videos.constants';

const PART_SIZE_BYTES = 5 * 1024 * 1024;

describe('UploadCompletionService (integration)', () => {
  let dataSource: DataSource;
  let persistence: VideosPersistenceService;
  let service: UploadCompletionService;
  let reconciliation: VideoUploadReconciliationService;
  let storage: S3StorageService;
  let client: S3Client;
  let userId: string;
  let channelId: string;
  let videoId: string;
  let uploadId: string;
  let objectKey: string;
  let storageUploadId: string;
  let orphanKey: string | undefined;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, Video, VideoUpload, VideoProcessingOutbox],
      { synchronize: false },
    );
    await dataSource.initialize();
    persistence = new VideosPersistenceService(dataSource);
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
    const publicClient = new S3Client({
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
    service = new UploadCompletionService(persistence, storage);
    reconciliation = new VideoUploadReconciliationService(
      persistence,
      storage,
      service,
    );
  });

  afterAll(async () => {
    client?.destroy();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `upload_completion_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Upload completion integration',
        nickname: `upload_completion_${suffix}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    objectKey = `integration-tests/${suffix}/source`;
    const video = await persistence.createDraft(
      channel.id,
      objectKey,
      String(PART_SIZE_BYTES),
    );
    videoId = video.id;
    const s3Upload = await storage.createMultipartUpload(
      objectKey,
      'video/mp4',
    );
    storageUploadId = s3Upload;
    const upload = await persistence.createUploadSession(
      video.id,
      s3Upload,
      String(PART_SIZE_BYTES),
      String(64 * 1024 * 1024),
      new Date(Date.now() + 60_000),
    );
    uploadId = upload.id;
    orphanKey = undefined;
  });

  afterEach(async () => {
    if (storageUploadId && objectKey) {
      await storage.abortMultipartUpload(objectKey, storageUploadId);
      await client.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET ?? 'videos',
          Key: objectKey,
        }),
      );
    }
    if (orphanKey) {
      await storage.abortMultipartUploadsForKey(orphanKey);
      await storage.deleteObject(orphanKey);
    }
    if (videoId) {
      await dataSource.getRepository(Video).delete({ id: videoId });
    }
    if (channelId)
      await dataSource.getRepository(Channel).delete({ id: channelId });
    if (userId) await dataSource.getRepository(User).delete({ id: userId });
    jest.restoreAllMocks();
  });

  async function uploadValidPart(): Promise<void> {
    await client.send(
      new UploadPartCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Key: objectKey,
        UploadId: storageUploadId,
        PartNumber: 1,
        Body: Buffer.alloc(PART_SIZE_BYTES, 7),
      }),
    );
  }

  it('completes a real MinIO multipart upload and commits video, session, and outbox atomically', async () => {
    await uploadValidPart();

    await expect(service.complete(userId, uploadId)).resolves.toEqual({
      videoId,
      status: 'processing',
    });
    await service.complete(userId, uploadId);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    const upload = await dataSource
      .getRepository(VideoUpload)
      .findOneByOrFail({ id: uploadId });
    const events = await dataSource
      .getRepository(VideoProcessingOutbox)
      .findBy({ video_id: videoId });
    expect(video).toMatchObject({
      status: 'processing',
      size_bytes: String(PART_SIZE_BYTES),
    });
    expect(upload.state).toBe('completed');
    expect(events).toHaveLength(1);
  }, 30000);

  it('rolls back processing and session state when the outbox insert fails', async () => {
    await uploadValidPart();
    await dataSource.getRepository(VideoProcessingOutbox).save(
      dataSource.getRepository(VideoProcessingOutbox).create({
        video_id: videoId,
        generation: 1,
        state: 'pending',
      }),
    );

    await expect(service.complete(userId, uploadId)).rejects.toThrow();
    const videoAfterFailure = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    const uploadAfterFailure = await dataSource
      .getRepository(VideoUpload)
      .findOneByOrFail({ id: uploadId });
    expect(videoAfterFailure.status).toBe('draft');
    expect(uploadAfterFailure.state).toBe('completing');

    await dataSource
      .getRepository(VideoProcessingOutbox)
      .delete({ video_id: videoId });
    await dataSource.query(
      'UPDATE "video_uploads" SET "updated_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - VIDEO_UPLOAD.COMPLETION_LEASE_MS - 1), uploadId],
    );
    await service.complete(userId, uploadId);
    expect(
      (await dataSource.getRepository(Video).findOneByOrFail({ id: videoId }))
        .status,
    ).toBe('processing');
  }, 30000);

  it('uses one winner for concurrent abort and completion transitions', async () => {
    await uploadValidPart();
    const [complete, abort] = await Promise.allSettled([
      service.complete(userId, uploadId),
      service.abort(userId, uploadId),
    ]);
    const persistedUpload = await dataSource
      .getRepository(VideoUpload)
      .findOneByOrFail({ id: uploadId });
    const persistedVideo = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
    const events = await dataSource
      .getRepository(VideoProcessingOutbox)
      .findBy({ video_id: videoId });

    if (persistedUpload.state === 'completed') {
      expect(complete.status).toBe('fulfilled');
      expect(abort.status).toBe('rejected');
      expect(persistedVideo.status).toBe('processing');
      expect(events).toHaveLength(1);
    } else {
      expect(persistedUpload.state).toBe('aborted');
      expect(abort.status).toBe('fulfilled');
      expect(complete.status).toBe('rejected');
      expect(persistedVideo.status).toBe('draft');
      expect(events).toHaveLength(0);
    }
  }, 30000);

  it('reconciles a completed S3 object left in completing state', async () => {
    await uploadValidPart();
    const parts = await storage.listParts(objectKey, storageUploadId);
    await persistence.claimUploadCompletion(uploadId);
    await dataSource.query(
      'UPDATE "video_uploads" SET "updated_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - VIDEO_UPLOAD.COMPLETION_LEASE_MS - 1), uploadId],
    );
    await storage.completeMultipartUpload(
      objectKey,
      storageUploadId,
      parts.parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
    );

    await reconciliation.reconcilePendingUploads();

    expect(
      (
        await dataSource
          .getRepository(VideoUpload)
          .findOneByOrFail({ id: uploadId })
      ).state,
    ).toBe('completed');
    expect(
      (await dataSource.getRepository(Video).findOneByOrFail({ id: videoId }))
        .status,
    ).toBe('processing');
    expect(
      await dataSource
        .getRepository(VideoProcessingOutbox)
        .countBy({ video_id: videoId }),
    ).toBe(1);
  }, 30000);

  it('fences stale completion workers from heartbeat, reset, rejection, and finish', async () => {
    await uploadValidPart();
    const staleToken = await persistence.claimUploadCompletion(uploadId);
    if (!staleToken)
      throw new Error('Could not claim initial completion lease');
    await dataSource.query(
      'UPDATE "video_uploads" SET "updated_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - VIDEO_UPLOAD.COMPLETION_LEASE_MS - 1), uploadId],
    );
    const currentToken = await persistence.claimUploadCompletion(uploadId);
    if (!currentToken) throw new Error('Could not take over stale completion');
    expect(currentToken).not.toBe(staleToken);

    await expect(
      persistence.renewUploadCompletion(uploadId, staleToken),
    ).resolves.toBe(false);
    await expect(
      persistence.resetUploadCompletion(uploadId, staleToken),
    ).resolves.toBe(false);
    await expect(
      persistence.rejectCompletedUpload(uploadId, staleToken),
    ).resolves.toBe(false);
    await expect(
      persistence.finishUpload(
        uploadId,
        videoId,
        String(PART_SIZE_BYTES),
        staleToken,
      ),
    ).resolves.toBe('conflict');

    const parts = await storage.listParts(objectKey, storageUploadId);
    await storage.completeMultipartUpload(
      objectKey,
      storageUploadId,
      parts.parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
    );
    await expect(
      persistence.finishUpload(
        uploadId,
        videoId,
        String(PART_SIZE_BYTES),
        currentToken,
      ),
    ).resolves.toBe('completed');
  }, 30000);

  it('allows only one claimant when an API completion races the reconciler lease', async () => {
    await uploadValidPart();
    await persistence.claimUploadCompletion(uploadId);
    await dataSource.query(
      'UPDATE "video_uploads" SET "updated_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - VIDEO_UPLOAD.COMPLETION_LEASE_MS - 1), uploadId],
    );

    await Promise.all([
      service.complete(userId, uploadId).catch(() => undefined),
      reconciliation.reconcilePendingUploads(),
    ]);

    expect(
      (
        await dataSource
          .getRepository(VideoUpload)
          .findOneByOrFail({ id: uploadId })
      ).state,
    ).toBe('completed');
    expect(
      await dataSource
        .getRepository(VideoProcessingOutbox)
        .countBy({ video_id: videoId }),
    ).toBe(1);
  }, 30000);

  it('cleans an old draft with no session after multipart creation compensation failed', async () => {
    const orphanObjectKey = `integration-tests/${Date.now()}-${Math.random()}/orphan`;
    orphanKey = orphanObjectKey;
    const orphanVideo = await persistence.createDraft(
      channelId,
      orphanObjectKey,
      String(PART_SIZE_BYTES),
    );
    await storage.createMultipartUpload(orphanObjectKey, 'video/mp4');
    await dataSource.query(
      'UPDATE "videos" SET "created_at" = $1, "updated_at" = $1 WHERE "id" = $2',
      [new Date(Date.now() - 26 * 60 * 60 * 1000), orphanVideo.id],
    );

    await reconciliation.reconcilePendingUploads();

    expect(
      await dataSource.getRepository(Video).findOneBy({ id: orphanVideo.id }),
    ).toBeNull();
    const remaining = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: process.env.S3_BUCKET ?? 'videos',
        Prefix: orphanObjectKey,
      }),
    );
    expect(
      (remaining.Uploads ?? []).filter(
        (upload) => upload.Key === orphanObjectKey,
      ),
    ).toHaveLength(0);
  }, 30000);
});
